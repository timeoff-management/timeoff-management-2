
/*
 * Mixin that inject to user model object consumer set of methods necessary for
 * dealing with absences.
 *
 * */

'use strict';

const { sorter } = require('../../../util');

var
  _                   = require('underscore'),
  Promise             = require("bluebird"),
  CalendarMonth       = require('../../calendar_month'),
  LeaveCollectionUtil = require('../../leave_collection')(),
  moment              = require('moment');

module.exports = function(sequelize){

  this._get_calendar_months_to_show = function(args){
    var
      self           = this,
      year           = args.year,
      show_full_year = args.show_full_year;

    let paramYear = '';
    try {
      paramYear = year.format('YYYY');
    } catch (error) {
      /* There is a bug not yet found that returns "args.year" with an invalid statement. */
      /* { year: Moment<2023-01-16T00:00:00Z>, show_full_year: true } */
      /* the code below has solved */
      const correctYear = year.toString();
      const crazy = correctYear.substring(7,4);      
      paramYear = crazy;
    }
    //console.log("crazy end |=> ", paramYear);
    
    if (show_full_year) {
      return _.map([1,2,3,4,5,6,7,8,9,10,11,12], function(i){        
        return moment.utc(paramYear +'-'+i+'-01');
      });
    }

    return _.map([0,1,2,3], function(delta){
      return self.company.get_today().add(delta, 'months').startOf('month');
    })
  };

  this.promise_calendar = function(args) {
    var
      this_user      = this,
      year           = args.year || this_user.company.get_today(),
      show_full_year = args.show_full_year || false,
      model          = sequelize.models,
      // Find out if we need to show multi year calendar
      is_multi_year = this_user.company.get_today().month() > 8;

    var months_to_show = this_user._get_calendar_months_to_show({
      year           : year.clone(),
      show_full_year : show_full_year
    });

    return Promise.join(

      Promise.try(() => this_user.getDepartment()),

      Promise.try(() => this_user.getCompany({
        scope : ['with_bank_holidays', 'with_leave_types']
      })),

      Promise.try(function(){
        return this_user.getMy_leaves({
          where : {
            $and : [
              { status : { $ne : sequelize.models.Leave.status_rejected() } },
              { status : { $ne : sequelize.models.Leave.status_canceled() } },
            ],
            $or : {
              date_start : {
                $between : [
                  moment.utc(year).startOf('year').format('YYYY-MM-DD'),
                  moment.utc(
                    year.clone().add((is_multi_year ? 1 : 0), 'years')
                  ).endOf('year').format('YYYY-MM-DD HH:mm'),
                ]
              },
              date_end : {
                $between : [
                  moment.utc( year ).startOf('year').format('YYYY-MM-DD'),
                  moment.utc(
                    year.clone().add((is_multi_year ? 1 : 0), 'years')
                  ).endOf('year').format('YYYY-MM-DD HH:mm'),
                ]
              }
            }
          },
        });
      }),

      Promise.try(() => this_user.promise_schedule_I_obey()),

      function(department, company, leaves, schedule){
        var leave_days = _.flatten( _.map(leaves, function(leave){
          return _.map( leave.get_days(), function(leave_day){
            leave_day.leave = leave;
            return leave_day;
          });
        }));

        return Promise.resolve(
          _.map(months_to_show, function(month){
            return new CalendarMonth(
              month,
              {
                bank_holidays :
                  department.include_public_holidays
                    ? company.bank_holidays
                    : [],
                leave_days : leave_days,
                schedule   : schedule,
                today      : company.get_today(),
                leave_types: company.leave_types,
              }
            );
          })
        );
      }

    ); // End of join
  };


  this.validate_overlapping = function(new_leave_attributes) {
    var this_user = this;

    var days_filter = {
      $between : [
        new_leave_attributes.from_date,
        moment.utc(new_leave_attributes.to_date)
          .add(1,'days').format('YYYY-MM-DD'),
      ],
    };

    return this_user.getMy_leaves({
      where : {
        $and : [
          { status : { $ne : sequelize.models.Leave.status_rejected() } },
          { status : { $ne : sequelize.models.Leave.status_canceled() } },
        ],

        $or : {
          date_start : days_filter,
          date_end : days_filter,
        },
      },
    })

    .then(function(overlapping_leaves){

      // Check there are overlapping leaves
      if (overlapping_leaves.length === 0){
          return Promise.resolve(1);
      }

      var overlapping_leave = overlapping_leaves[0];

      if (overlapping_leave.fit_with_leave_request(
            new_leave_attributes
      )){
          return Promise.resolve(1);
      }

      // Otherwise it is overlapping!
      var error = new Error('Overlapping booking!');
      error.user_message = 'Overlapping booking!';
      throw error;

    });
  }; // end of validate_overlapping


  // Promise all leaves requested by current user, regardless
  // their statuses
  //
  this.promise_my_leaves = function(args){

    var self         = this,
        where_clause = args.filter || {},
        // Time zone does not really matter here, although there could be issues
        // around New Year (but we can tolerate that)
        year         = args.year || moment.utc();

    if (args && args.filter_status) {
      where_clause = { status : args.filter_status };
    }

    if (args && ! args.ignore_year) {
      where_clause['$or'] = {
        date_start : {
          $between : [
            moment.utc(year).startOf('year').format('YYYY-MM-DD'),
            moment.utc(year).endOf('year').format('YYYY-MM-DD HH:mm'),
          ]
        },
        date_end : {
          $between : [
            moment.utc(year).startOf('year').format('YYYY-MM-DD'),
            moment.utc(year).endOf('year').format('YYYY-MM-DD HH:mm'),
          ]
        }
      };

    // Case when there are start and end date defined
    } else if (args && args.dateStart && args.dateEnd) {
      const {dateStart, dateEnd} = args;

      where_clause['$or'] = {
        date_start : {
          $between : [
            moment.utc(dateStart).startOf('day').format('YYYY-MM-DD'),
            moment.utc(dateEnd).endOf('day').format('YYYY-MM-DD HH:mm'),
          ]
        },
        date_end : {
          $between : [
            moment.utc(dateStart).startOf('day').format('YYYY-MM-DD'),
            moment.utc(dateEnd).endOf('day').format('YYYY-MM-DD HH:mm'),
          ]
        },
        // Case when given data range is within existing leave
        $and: {
          date_start: {$lte: moment.utc(dateStart).startOf('day').format('YYYY-MM-DD')},
          date_end: {$gte: moment.utc(dateEnd).endOf('day').format('YYYY-MM-DD')},
        }
      };
    }

    var promise_my_leaves = this.getMy_leaves({
      // TODO here is cartesian product between leave types and users,
      // needs to be split
      include : [{
        model : sequelize.models.LeaveType,
        as    : 'leave_type',
      },{
        model : sequelize.models.User,
        as    : 'user',
        include : [{
          model : sequelize.models.Company,
          as : 'company',
          include : [{
            model : sequelize.models.BankHoliday,
            as : 'bank_holidays',
          }],
        }],
      }],
      where : where_clause,
    })

    // Fetch approvers for each leave in separate query, to avoid cartesian
    // products.
    .then(function(leaves){

      leaves.forEach(function(leave){ leave.user.cached_schedule = self.cached_schedule; });

      return Promise.resolve(leaves)
        .map(
          function(leave){
            return leave.promise_approver()
            .then(function(approver){
              leave.approver = approver;
              return Promise.resolve(leave);
            });
          }, {
            concurrency : 10,
          }
        );
    })

    .then(async (leaves) => {
      const department = await self.getDepartment();
      leaves.forEach(l => l.user.department = department);
      return leaves;
    })

    .then(leaves => LeaveCollectionUtil.promise_to_sort_leaves(leaves));

    return promise_my_leaves;
  };


  this.promise_my_active_leaves = function(args) {
    var year = args.year || moment.utc();

    return this.promise_my_leaves({
      year          : year,
      filter_status : [
        sequelize.models.Leave.status_approved(),
        sequelize.models.Leave.status_new(),
        sequelize.models.Leave.status_pended_revoke(),
      ],
    })
    .then(leaves => LeaveCollectionUtil.promise_to_sort_leaves(leaves));
  };

  this.getMyActiveLeavesForDateRange = async function({dateStart, dateEnd}) {
    const self = this;

    const rawLeaves = await self.promise_my_leaves({
      ignore_year: true,
      dateStart,
      dateEnd,
      filter_status : [
        sequelize.models.Leave.status_approved(),
        sequelize.models.Leave.status_new(),
        sequelize.models.Leave.status_pended_revoke(),
      ],
    });

    const leaves = await LeaveCollectionUtil.promise_to_sort_leaves(rawLeaves);

    return leaves;
  };

  // Promises leaves ever booked for current user
  this.promise_my_active_leaves_ever = function() {

    return this.promise_my_leaves({
      ignore_year : true,
      filter_status : [
        sequelize.models.Leave.status_approved(),
        sequelize.models.Leave.status_new(),
        sequelize.models.Leave.status_pended_revoke(),
      ],
    })
    .then(leaves => LeaveCollectionUtil.promise_to_sort_leaves(leaves));
  };


  // Promise leaves that are needed to be Approved/Rejected
  //
  this.promise_leaves_to_be_processed = function(){
    let self = this;

    return self
      .promise_supervised_users()
      .then(users => {
        return sequelize.models.Leave.findAll({
          include : [{
            model : sequelize.models.LeaveType,
            as    : 'leave_type',
          },{
            model : sequelize.models.User,
            as    : 'user',
            include : [{
              model : sequelize.models.Company,
              as : 'company',
              include : [{
                model : sequelize.models.BankHoliday,
                as    : 'bank_holidays',
              }],
            },{
              model : sequelize.models.Department,
              as    : 'department',
            }],
          }],
          where : {
            status : [
              sequelize.models.Leave.status_new(),
              sequelize.models.Leave.status_pended_revoke()
            ],
            userId : users.map(u => u.id),
          },
        })
      })
      .then( leaves => Promise
        .resolve(leaves)
        .map(
          leave => leave.user.promise_schedule_I_obey(),
          { concurrency : 10 }
        )
        .then( () => Promise.resolve(leaves) )
        .then(leaves => LeaveCollectionUtil.promise_to_sort_leaves(leaves))
      );
  }; // END of promise_leaves_to_be_processed

  this.promise_cancelable_leaves = function(){
    var self = this;

    return self.promise_my_leaves({
      ignore_year : true,
      filter_status : [ sequelize.models.Leave.status_new() ],
    })
    .then(function(leaves){
      return Promise.map(leaves, function(leave){
        return leave.user.promise_schedule_I_obey();
      },{
        concurrency : 10,
      })
      .then(function(){ return Promise.resolve(leaves) })
      .then(leaves => LeaveCollectionUtil.promise_to_sort_leaves(leaves));
    });
  };


  this.calculate_number_of_days_taken_from_allowance = function(args){
    var self = this,
        leave_type = args ? args.leave_type : null,
        leaves_to_traverse = this.my_leaves || [];


    leaves_to_traverse.forEach(function(leave){ leave.user.cached_schedule = self.cached_schedule; });

    // If leave_type was provided, we care only about leaves of that type
    if (leave_type) {
      leaves_to_traverse = _.filter(
        leaves_to_traverse,
        function(leave){ return leave.leaveTypeId === leave_type.id; }
      );
    }

    return _.reduce(
      _.map(
        _.filter(
          leaves_to_traverse,
          function (leave){ return leave.is_approved_leave(); }
        ),
        function(leave){ return leave.get_deducted_days_number(args); }
      ),
      function(memo, num){ return memo + num },
      0
    ) || 0;
  };


  // Based on leaves attached to the current user object,
  // the method does not perform any additional queries
  //
  this.get_leave_statistics_by_types = function(args){

    if (! args ) args = {};

    var statistics = {},
      limit_by_top = args.limit_by_top || false;

    this.company.leave_types.forEach(function(leave_type){
      var initial_stat = {
        leave_type : leave_type,
        days_taken : 0,
      };
      if (leave_type.limit && leave_type.limit > 0) {
        initial_stat.limit = leave_type.limit;
      }
      statistics[leave_type.id] = initial_stat;
    });

    // Calculate statistics as an object
    _.filter(
      this.my_leaves,
      function (leave){ return leave.is_approved_leave() }
    )
    .forEach(
      function(leave){

        var stat_obj = statistics[leave.leave_type.id];

        stat_obj.days_taken = stat_obj.days_taken + leave.get_deducted_days_number({
          ignore_allowance : true,
        });
      }
    );

    var statistic_arr = _.map(
      _.pairs(statistics),
      function(pair){
        return pair[1];
      }
    );

    statistic_arr = statistic_arr
      .sort((a,b) => sorter(a.days_taken, b.days_taken))
      .reverse();


    if (limit_by_top) {
      statistic_arr = _.first(statistic_arr, 4);
    }

    return statistic_arr.sort((a,b) => sorter(a.leave_type.name, b.leave_type.name));
  },


  this.promise_adjustment_and_carry_over_for_year = function(year){
    let self = this;

    year = year || moment.utc();
    year = moment.utc(year).format('YYYY');

    return self
      .getAdjustments({
        where : { year : year }
      })
      .then(adjustment_records => {

        // By deafault there is not adjustments
        let result = {
          adjustment : 0,
          carried_over_allowance : 0,
        };

        if (adjustment_records.length === 1) {
          result.adjustment = adjustment_records[0].adjustment;
          result.carried_over_allowance = adjustment_records[0].carried_over_allowance;
        }

        return Promise.resolve(result);
      });
  };

  this.promise_adjustmet_for_year = function(year){
    let self = this;

    return self
      .promise_adjustment_and_carry_over_for_year(year)
      .then(combined_record => Promise.resolve(combined_record.adjustment));
  };

  this.promise_carried_over_allowance_for_year = function(year){
    let self = this;

    return self
      .promise_adjustment_and_carry_over_for_year(year)
      .then(combined_record => Promise.resolve(combined_record.carried_over_allowance));
  };

  this.promise_to_update_adjustment = function(args) {
    let
      self = this,
      year = args.year || moment.utc().format('YYYY'),
      adjustment = args.adjustment;

    // Update related allowance adjustement record
    return sequelize.models.UserAllowanceAdjustment
      .findOrCreate({
        where : {
          user_id : self.id,
          year    : year,
        },
        defaults : { adjustment : adjustment },
      })
      .spread((record, created) => {

        if ( created ) {
          return Promise.resolve();
        }

        record.set('adjustment', adjustment);

        return record.save();
      });
  };

  this.promise_to_update_carried_over_allowance = function(args) {
    let
      self = this,
      year = args.year || moment.utc().format('YYYY'),
      carried_over_allowance = args.carried_over_allowance;

    // Update related allowance adjustement record
    return sequelize.models.UserAllowanceAdjustment
      .findOrCreate({
        where : {
          user_id : self.id,
          year    : year,
        },
        defaults : { carried_over_allowance : carried_over_allowance },
      })
      .spread((record, created) => {

        if ( created ) {
          return Promise.resolve();
        }

        record.set('carried_over_allowance', carried_over_allowance);

        return record.save();
      });
  };


  this.promise_my_leaves_for_calendar = function(args){
    var year = args.year || this.company.get_today();

    return this.getMy_leaves({
      where : {

        $and : [
          { status : { $ne : sequelize.models.Leave.status_rejected() } },
          { status : { $ne : sequelize.models.Leave.status_canceled() } },
        ],

        $or : {
          date_start : {
            $between : [
              moment.utc(year).startOf('year').format('YYYY-MM-DD'),
              moment.utc(year).endOf('year').format('YYYY-MM-DD HH:mm'),
            ]
          },
          date_end : {
            $between : [
              moment.utc(year).startOf('year').format('YYYY-MM-DD'),
              moment.utc(year).endOf('year').format('YYYY-MM-DD HH:mm'),
            ]
          }
        }
      },
    }); // End of MyLeaves
  };

  // For given leave object (not necessary one with corresponding record in DB)
  // check if current user is capable to have it, that is if user's remaining
  // vacation allowance is big enough to accommodate the leave.
  //
  // If validation fails an exceptionis thrown.
  //
  this.validate_leave_fits_into_remaining_allowance = function(args){
    var self   = this,
    leave_type = args.leave_type,
    leave      = args.leave,
    // Derive year from Leave object
    year       = args.year || moment.utc(leave.date_start);

    // Make sure object contain all necessary data for that check
    return self.reload_with_leave_details({
      year : year.clone(),
    })
    .then( employee => employee.reload_with_session_details() )
    .then(employee => employee.company.reload_with_bank_holidays()
      .then(() => Promise.resolve(employee))
    )
    .then(employee =>
      employee.promise_allowance({year})
      .then(allowance_obj => Promise.resolve([allowance_obj.number_of_days_available_in_allowance, employee]))
    )
    .then(function(args){
      let days_remaining_in_allowance = args[0],
        employee = args[1];

      let deducted_days =  leave.get_deducted_days_number({
          year       : year.format('YYYY'),
          user       : employee,
          leave_type : leave_type,
        });

      // Throw an exception when less than zero vacation would remain
      // if we add currently requested absence
      if (
        days_remaining_in_allowance - deducted_days < 0
      ) {

        var error = new Error('Requested absence is longer than remaining allowance');
        error.user_message = error.toString();
        throw error;
      }

      return Promise.resolve(employee);
    })

    // Check that adding new leave of this type will not exceed maximum limit of
    // that type (if it is defined)
    .then(function(employee){
      if (
        // There is a limit for current type
        leave_type.limit
        // ... and lemit is bigger than zero
        && leave_type.limit > 0
      ) {

        // ... sum of used dayes for this limit is going to be bigger then limit
        var would_be_used = employee.calculate_number_of_days_taken_from_allowance({
            year             : year.format('YYYY'),
            leave_type       : leave_type,
            ignore_allowance : true,
          })
            +
          leave.get_deducted_days_number({
            year             : year.format('YYYY'),
            user             : employee,
            leave_type       : leave_type,
            ignore_allowance : true,
          });

        if (would_be_used > leave_type.limit) {

          var error = new Error('Adding requested '+leave_type.name
            +" absence would exceed maximum allowed for such type by "
            +(would_be_used - leave_type.limit)
          );

          error.user_message = error.toString();
          throw error;
        }
      }

      return Promise.resolve();
    });
  };

};

