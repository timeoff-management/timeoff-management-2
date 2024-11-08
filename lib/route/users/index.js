
"use strict";

const
  express   = require('express'),
  router    = express.Router(),
  validator = require('validator'),
  Promise   = require('bluebird'),
  moment    = require('moment'),
  _         = require('underscore'),
  csv       = Promise.promisifyAll(require('csv')),
  fs        = require("fs"),
  formidable          = require('formidable'),
  LeaveCollectionUtil = require('../../model/leave_collection')(),
  Exception           = require('../../error'),
  UserImporter        = require('../../model/user_importer'),
  EmailTransport      = require('../../email'),  
  config              = require('../../config'),
  {getAuditCaptureForUser} = require('../../model/audit');

const { sorter } = require("../../util");

// Make sure that current user is authorized to deal with settings
router.all(/.*/, require('../../middleware/ensure_user_is_admin'));

router.get('/add/', function(req, res){
  req.user
    .get_company_for_add_user()
    .then(function(company){
      res.render('user_add', {
        company : company,
        departments: company.departments.sort((a, b) => sorter(a.name, b.name)),
      });
    });
});

router.post('/add/', function(req, res){

  const
    Email = new EmailTransport();

  let current_company,
      new_user_attributes;

  req.user
  .get_company_for_add_user()
  .then(function(company){

    current_company = company;

    new_user_attributes = get_and_validate_user_parameters({
      req              : req,
      item_name        : 'user',
      departments      : company.departments,
      // If current company has LDAP auth do not require password
      require_password : (company.ldap_auth_enabled ? false : true ),
    });

    return Promise.resolve();
  })

  // Make sure that we do not add user with existing emails
  .then(() => UserImporter
    .validate_email_to_be_free({ email : new_user_attributes.email })
  )

  // Add new user to database
  .then(() => UserImporter.add_user({
    name          : new_user_attributes.name,
    lastname      : new_user_attributes.lastname,
    email         : new_user_attributes.email,
    department_id : new_user_attributes.DepartmentId,
    start_date    : new_user_attributes.start_date,
    end_date      : new_user_attributes.end_date,
    admin         : new_user_attributes.admin,
    auto_approve  : new_user_attributes.auto_approve,
    company_id    : req.user.companyId,
    password      : new_user_attributes.password,
  }))

  .then(new_user => {
    var isCanSend = JSON.parse(config.get('send_emails')) || false;
    if (isCanSend) {
      Email.promise_add_new_user_email({
        company    : current_company,
        admin_user : req.user,
        new_user   : new_user,
      });
    }
  })
  .then(function(){
    if ( req.session.flash_has_errors() ) {
      return res.redirect_with_session('../add/');
    } else {
      req.session.flash_message('New user account successfully added');
      return res.redirect_with_session('../');
    }
  })

  .catch(function(error){
    console.log(
      'An error occurred when trying to add new user account by user '+req.user.id
    );
    console.dir(error);

    if ( error && error.tom_error) {
      req.session.flash_error( Exception.extract_user_error_message(error) );
    }

    req.session.flash_error(
      'Failed to add new user'
    );

    return res.redirect_with_session('../add/');
  });
});

router.get('/import/', function(req, res){
  req.user
    .getCompany()
    .then(company => res.render(
      'users_import', {
        company : company,
      }
    ));
});

router.post('/import/', function(req, res){
  let
    form = new formidable.IncomingForm(),
    parseAsync = Promise.promisify(form.parse);

  parseAsync
    .call(form, req)
    .then(args => {

      let files = args[1];

      if (files.users_import.size === 0) {
        Exception.throw_user_error({
          user_error   : 'No .CSV file to restore from was provided',
          system_error : 'User ' + req.user.id + ' tried to import employees '
            + 'without submitting .CSV file',
        });
      } else if ( files.users_import.size > 2097152 ) {
        Exception.throw_user_error({
          user_error   : '.CSV file could not be bigger then 2M',
          system_error : 'User ' + req.user.id + ' tried to submit file bigger then '
            + '2M',
        });
      }

      return fs.readFileAsync(files.users_import.path, "utf8");
    })
    .then(csv_data_string => csv.parseAsync(csv_data_string,{trim:true}))
    .then(parsed_data => {

      // Limit number of employees to be imported at one go
      //
      if (parsed_data.length > 201) {
        Exception.throw_user_error({
          user_error : 'Cannot import more then 200 employees per one go. '
            + 'Please splite .CSV file into chunks of no more then 200 employees '
            + 'and process them each at the time',
          system_error : 'User ' + req.user.id + ' tried to import more then 200 '
            + 'user at one time'
        });
      }

      return UserImporter.add_users_in_bulk({
        to_company_id : req.user.companyId,
        bulk_header   : parsed_data.shift(),
        bulk_data     : parsed_data,
      });
    })
    .then(action_result => {
      console.dir(action_result);
      if ( action_result.users.length > 0 ) {
        req.session.flash_message(
          'Successfully imported users with following emails: '
            + action_result.users.map(user => user.email).sort().join(', ')
        );
      }
      if (action_result.errors.length > 0) {
        action_result.errors.forEach(err => req.session.flash_error(
          'Failed to add user ' + err.email + '. Reason: ' + err.error
        ));
      }
      res.redirect_with_session('/users/import/');
    })
    .catch(function(error){
      console.error(
        'An error occurred when trying to import users for company'
          + req.user.companyId
          + '. Reason: ' + Exception.extract_system_error_message(error)
      );
      req.session.flash_error(
        'Failed to import users, reason: '
          + Exception.extract_user_error_message(error)
      );
      res.redirect_with_session('/users/import/');
    });
});

router.post('/import-sample/', function(req, res){

  req.user
    .getCompany({
      scope : ['with_active_users', 'with_simple_departments'],
    })
    .then(company => {

      res.attachment(
        company.name_for_machine()+'.csv'
      );

      let content = company.users.map( user => [
        user.email,
        user.lastname,
        user.name,
        company.departments.find( dep => dep.id === user.DepartmentId ).name
      ]);

      content.unshift( ['email','lastname', 'name', 'department'] );

      return csv.stringifyAsync( content );
    })
    .then(csv_data_string => res.send(csv_data_string));

});

router.get('/edit/:user_id/', function(req, res){
  const user_id = validator.trim(req.params['user_id']);

  Promise
  .try(() => ensure_user_id_is_integer({req : req, user_id : user_id}))
  .then(() => req.user.get_company_for_user_details({user_id}))
  .then(function(company){

    const employee = company.users[0];

    return employee.promise_schedule_I_obey()
      .then(function(){
        res.render('user_details', {
          company       : company,
          employee      : employee,
          show_main_tab : true,
          departments: company.departments.sort((a, b) => sorter(a.name, b.name)),
        });
      });
  })
  .catch(function(error){
    console.error(
      'An error occurred when trying to open employee details by user '+req.user.id
      + ' : ' + error
    );

    return res.redirect_with_session('../../');
  });
});

router.get('/edit/:user_id/absences/', function(req, res){
  let
    user_id = validator.trim(req.params['user_id']),
    user_allowance;

  const dbModel = req.app.get('db_model');

  Promise

  .try( () => ensure_user_id_is_integer({req : req, user_id : user_id}) )
  .then(() => req.user.get_company_for_user_details({ user_id : user_id }) )
  .then(function(company){
    let employee = company.users[0];
    return employee.reload_with_session_details();
  })
  .then( employee => employee.reload_with_leave_details({}))
  .then(employee => Promise.join(

    employee
      .promise_allowance()
      .then( allowance_obj => Promise.resolve([user_allowance = allowance_obj, employee]) ),

    employee
      .promise_adjustmet_for_year(moment.utc().format('YYYY')),

    employee
      .promise_carried_over_allowance_for_year(moment.utc().format('YYYY')),

    (args, employee_adjustment, carried_over_allowance) => {
      args.push(null);
      args.push(employee_adjustment);
      args.push(carried_over_allowance);
      return Promise.resolve(args);
    })
  )
  .then(args => {
    let
      allowance_obj = args[0],

      remaining_allowance = allowance_obj.total_number_of_days_in_allowance - allowance_obj.number_of_days_taken_from_allowance,
      employee = args[1],
      total_days_number = allowance_obj.total_number_of_days_in_allowance,
      employee_adjustment = args[3],
      carried_over_allowance = args[4];

    let leave_statistics = {
      total_for_current_year : total_days_number,
      remaining              : remaining_allowance,
    };

    leave_statistics.used_so_far = allowance_obj.number_of_days_taken_from_allowance;

    leave_statistics.used_so_far_percent = leave_statistics.total_for_current_year > 0
      ? 100 * leave_statistics.used_so_far / leave_statistics.total_for_current_year
      : 0;

    leave_statistics.remaining_percent = leave_statistics.total_for_current_year > 0
      ? 100 *  (leave_statistics.total_for_current_year - leave_statistics.used_so_far) / leave_statistics.total_for_current_year
      : 0;

    return employee
      .promise_schedule_I_obey()
      .then(function(){
        employee
          .promise_my_active_leaves_ever({})
          .then(leaves => LeaveCollectionUtil.enrichLeavesWithComments({leaves, dbModel}))
          .then(leaves => LeaveCollectionUtil.promise_to_group_leaves(leaves))
          .then(function(grouped_leaves){

            res.render('user_details', {
              employee         : employee,
              grouped_leaves   : grouped_leaves,
              show_absence_tab : true,
              leave_type_statistics : employee.get_leave_statistics_by_types(),
              leave_statistics      : leave_statistics,
              employee_adjustment   : employee_adjustment,
              carried_over_allowance: carried_over_allowance,
              user_allowance        : user_allowance,
            });

          });
      });
  })
  .catch(function(error){
    console.error(
      'An error occurred when trying to open employee absences by user '+req.user.id
      + ' : ' + error
    );

    return res.redirect_with_session('../../../');
  });
});


router.get('/edit/:user_id/schedule/', function(req, res){
  var user_id = validator.trim(req.params['user_id']);

  Promise.try(function(){
    ensure_user_id_is_integer({req : req, user_id : user_id});
  })
  .then(function(){
    return req.user.get_company_for_user_details({
      user_id : user_id,
    });
  })
  .then(function(company){

    var employee = company.users[0];

    return employee
      .promise_schedule_I_obey()
      .then(function(schedule){
        res.render('user_details', {
          employee          : employee,
          schedule          : schedule,
          show_schedule_tab : true,
        });
      });
  })
  .catch(function(error){
    console.error(
      'An error occurred when trying to open employee absences by user '+req.user.id
      + ' : ' + error
    );

    return res.redirect_with_session('../../../');
  });
});

router.get('/edit/:user_id/calendar/', async (req, res) => {
  const userId = validator.trim(req.params['user_id']);

  const year = validator.isNumeric(req.query['year'])
    ? moment.utc(req.query['year'], 'YYYY')
    : req.user.company.get_today();

  let employee, calendar, companyEnriched, user, supervisors, userAllowance;

  try {
    await ensure_user_id_is_integer({req, user_id: userId});

    const company = await req.user.get_company_for_user_details({
      user_id : userId,
    });

    employee = company.users[0];

    await employee.reload_with_session_details();

    calendar = await employee.promise_calendar({
      year: year.clone(),
      show_full_year: true,
    });
    companyEnriched = await employee.get_company_with_all_leave_types();
    employee = await employee.reload_with_leave_details({ year });
    supervisors = await employee.promise_supervisors();
    userAllowance = await employee.promise_allowance({ year });

  } catch (error) {

    console.error(
      `An error ocurred while trying to render Calendar for user [${userId}]: ${error} at ${error.stack}`
    );

    return res.redirect_with_session('../../../');
  }

  const fullLeaveTypeStatistics = employee.get_leave_statistics_by_types();

  res.render('user_details', {
    employee,
    show_calendar_tab : true,

    calendar : calendar.map(c => c.as_for_template()),
    company        : companyEnriched,
    current_user   : employee,
    supervisors    : supervisors,
    previous_year  : moment.utc(year).add(-1,'year').format('YYYY'),
    current_year   : year.format('YYYY'),
    next_year      : moment.utc(year).add(1,'year').format('YYYY'),
    show_full_year : true,
    user_allowance : userAllowance,
    leave_type_statistics: fullLeaveTypeStatistics.filter(st => st.days_taken > 0),
  });
});



// Special step performed while saving existing employee account details
//
// In case when employee had "end date" populated and now it is going
// to be updated to be in future - check if during the time user was inactive
// new user was added (including other companies)
//
var ensure_user_was_not_useed_elsewhere_while_being_inactive = function(args){
  var
    employee            = args.employee,
    new_user_attributes = args.new_user_attributes,
    req                 = args.req,
    model               = args.model;

  if (
    // Employee has end_date defined
    employee.end_date &&
    (
     ! new_user_attributes.end_date
     ||
      (
        // new "end_date" is provided
        // new "end_date" is in future
        new_user_attributes.end_date &&
        moment.utc( new_user_attributes.end_date ).startOf('day').toDate() >= req.user.company.get_today().startOf('day').toDate()
      )
    )
  ) {
    return model.User.find_by_email(new_user_attributes.email)
      .then(function(user){

        if (user && user.companyId !== employee.companyId) {
          var error_msg = 'There is an active account with similar email somewhere within system.';
          req.session.flash_error(error_msg);
          throw new Error(error_msg);
        }

        return Promise.resolve();
      });
  }

  return Promise.resolve();
};

// Extra step: in case when employee is going to have new email,
// check that it is not duplicated
//
var ensure_email_is_not_used_elsewhere = function(args){
  var
    employee            = args.employee,
    new_user_attributes = args.new_user_attributes,
    req                 = args.req,
    model               = args.model;

  if (new_user_attributes.email === employee.email) {
    return Promise.resolve();
  }

  return model.User
    .find_by_email(new_user_attributes.email)
    .then(function(user){

      if (user) {
        req.session.flash_error('Email is already in use');
        throw new Error('Email is already used');
      }

      return Promise.resolve();
    });
};

var ensure_we_are_not_removing_last_admin = function(args){
  var
    employee            = args.employee,
    new_user_attributes = args.new_user_attributes,
    req                 = args.req,
    model               = args.model;

  if (
    // It is about to change admin rights
    new_user_attributes.admin !== employee.admin
    // and it is revoking admin rights
    && ! new_user_attributes.admin
  ) {
    return model.User
      .count({ where : {
        companyId : employee.companyId,
        id        : { $ne : employee.id},
        admin     : true,
      }})
      .then(function(number_of_admins_to_be_left){
        if (number_of_admins_to_be_left > 0) {
          return Promise.resolve();
        }

        req.session.flash_error('This is last admin within company. Cannot revoke admin rights.');
        throw new Error('Attempt to revoke admin rights from last admin in comapny '+employee.companyId);
      });
  }

  return Promise.resolve();
};

router.post('/edit/:user_id/', function(req, res){
  var user_id = validator.trim(req.params['user_id']);

  var new_user_attributes,
    employee,
    model = req.app.get('db_model');

  Promise.try(function(){
    ensure_user_id_is_integer({req : req, user_id : user_id});
  })
  .then(function(){
    return req.user.get_company_for_user_details({
      user_id : user_id,
    });
  })
  .then(function(company){

    new_user_attributes = get_and_validate_user_parameters({
      req         : req,
      item_name   : 'user',
      departments : company.departments,
    });

    if (new_user_attributes.password) {
      new_user_attributes.password = model.User.hashify_password(
        new_user_attributes.password
      );
    }

    employee = company.users[0];

    return Promise.resolve();
  })

  // Ensure that new email if it was changed is not used anywhere else
  // withing system
  .then(function(){ return ensure_email_is_not_used_elsewhere({
    employee            : employee,
    new_user_attributes : new_user_attributes,
    req                 : req,
    model               : model,
  })})

  // Double check user in case it is re-activated
  .then(function(){ return ensure_user_was_not_useed_elsewhere_while_being_inactive({
    employee            : employee,
    new_user_attributes : new_user_attributes,
    req                 : req,
    model               : model,
  })})

  .then(function(){ return ensure_we_are_not_removing_last_admin({
    employee            : employee,
    new_user_attributes : new_user_attributes,
    req                 : req,
    model               : model,
  })})

  // All validations are passed: update database
  .then(function(){

    let adjustment = new_user_attributes.adjustment;
    delete new_user_attributes.adjustment;

    const captureAuditTrail = getAuditCaptureForUser({
      byUser: req.user,
      forUser: employee.get({plain: true}),
      newAttributes: new_user_attributes,
    });

    employee

      // Update user record
      .updateAttributes(new_user_attributes)

      .then(() => captureAuditTrail())

      // Update adjustment if necessary
      .then(() => {
        if ( adjustment !== undefined  ) {
          return employee.promise_to_update_adjustment({
            year : moment.utc().format('YYYY'),
            adjustment : adjustment,
          });
        }

        return Promise.resolve();
      })

      .then(function(){
        req.session.flash_message(
          'Details for '+employee.full_name()+' were updated'
        );
        return res.redirect_with_session(req.body.back_to_absences ? './absences/' : '.');
      });
  })

  .catch(function(error){
    console.error(
      'An error occurred when trying to save chnages to user account by user '+req.user.id
      + ' : ' + error
    );

    req.session.flash_error(
      'Failed to save changes.'
    );

    return res.redirect_with_session(req.body.back_to_absences ? './absences/' : '.');
  });
});


router.post('/delete/:user_id/', function(req, res){
    const user_id = validator.trim(req.params['user_id']);
    let auditCapture;

    Promise.try(() => ensure_user_id_is_integer({req, user_id}))
    .then(() => req.user.get_company_for_user_details({user_id}))
    .then(company => {
      const employee = company.users[0];
      const employeePlain = employee.get({plain: true});
      auditCapture = getAuditCaptureForUser({
        byUser:        req.user,
        forUser:       employeePlain,
        newAttributes: Object.assign(
          {},
          ...Object.keys(employeePlain).map(k => ({[k]:null}))
        ),
      });
      return employee.remove();
    })
    .then(() => auditCapture())
    .then(() => {
      req.session.flash_message(
        'Employee records were removed from the system'
      );
      return res.redirect_with_session('../..');
    })
    .catch(error => {
      console.error(
        `An error occurred when trying to remove user ${user_id} by user `
          + `${req.user.id}. Error: ${error}`
      );

      req.session.flash_error(`Failed to remove user. ${error}`);

      return res.redirect_with_session(`../../edit/${user_id}/`);
    });
});


router.all('/search/', function(req, res){

  // Currently we support search only by email and only JSON type requests
  if ( ! req.accepts('json')) {
    // redirect client to the users index page
    return res.redirect_with_session('../');
  }

  var email = validator.trim( req.body['email'] ).toLowerCase();

  if ( ! validator.isEmail( email )) {
    req.session.flash_error('Provided email does not look like valid one: "'+email+'"');
    return res.json([]);
  }

  // search for users only related to currently login admin
  //
  var promise_result = req.user.getCompany({
    include : [{
      model : req.app.get('db_model').User,
      as : 'users',
      where : {
        email : email
      }
    }]
  });

  promise_result.then(function(company){
    if (company.users.length > 0) {
      res.json(company.users)
    } else {
      res.json([]);
    }
  });
});


/* Handle the root for users section, it shows the list of all users
 * */
router.get('/', function(req, res) {

    var department_id = req.query['department'],
        users_filter = {},
        model = req.app.get('db_model');

    if (validator.isNumeric( department_id )) {
      users_filter = { DepartmentId : department_id };
    } else {
      department_id = undefined;
    }

    req.user.getCompany({
      include : [
        {
          model    : model.User,
          as       : 'users',
          where    : users_filter,
          required : false,
          include : [
            { model : model.Department, as : 'department' },
            // Following is needed to be able to calculate how many days were
            // taken from allowance
            {
              model    : model.Leave,
              as       : 'my_leaves',
              required : false,
              where : {
                // status : model.Leave.status_approved(),
                status : [
                  model.Leave.status_approved(),
                  model.Leave.status_new(),
                  model.Leave.status_pended_revoke(),
                ],
                $or : {
                  date_start : {
                    $between : [
                      moment.utc().startOf('year').format('YYYY-MM-DD'),
                      moment.utc().endOf('year').format('YYYY-MM-DD HH:mm'),
                    ]
                  },
                  date_end : {
                    $between : [
                      moment.utc().startOf('year').format('YYYY-MM-DD'),
                      moment.utc().endOf('year').format('YYYY-MM-DD HH:mm'),
                    ]
                  }
                }
              },
              include : [{
                    model : model.LeaveType,
                    as    : 'leave_type',
                },
              ] // End of my_leaves include
            }
          ],
        },
      ],
    })

    // Make sure that objects have all necessary attributes to render page
    // (template system is sync only)
    .then(function(company){
      return company.getBank_holidays()
        // stick bank holidays to company
        .then(function(bank_holidays){
          company.bank_holidays = bank_holidays;
          return company.getDepartments({
            order : [ model.Department.default_order_field() ],
          });
        })
        // stick departments to company as well
        .then(function(departments){
          company.departments = departments.sort((a,b) => sorter(a.name, b.name));
          return Promise.resolve(company);
        })
    })

    // Make sure that user's leaves have reference back to user in question
    .then(function(company){
      company.users.forEach(function(user){
        user.company = company;
        user.my_leaves.forEach(function(leave){ leave.user = user });
      });

      return Promise.resolve(company);
    })

    // Update users to have neccessary data for leave calculations
    .then(function(company){
      return Promise.resolve(company.users).map(function(user){
        return user.promise_schedule_I_obey();
      },{
        concurrency : 10,
      })
      .then(function(){ return Promise.resolve(company) });
    })

    /*
     * Following block builds array of object for each user in company.
     * Each object consist of following keys:
     *  - user_row : reference to the sequelize user row object
     *  - number_of_days_available_in_allowance : number of days remaining in allowance for given user
     *
     * This step is necessary because we are moving to non-blocking API for libraries,
     * so we need to get all data before passing it into template as template
     *
     * */
    .then(company => Promise
      .resolve(company.users)
      .map(user => user
        .promise_allowance()
        .then(allowance_obj => Promise.resolve({
          user_row : user,
          number_of_days_available_in_allowance : allowance_obj.number_of_days_available_in_allowance,
        })),
        {
          concurrency : 10
        }
      )
      .then(users_info => Promise.resolve([company, users_info]))
    )

    // We are moving away from passing complex objects into templates
    // for calling complicated methods from within templates
    // Now only basic simple objects to be sent over to the template,
    // all preparation to be done before rendering.
    //
    // So prepare special rendering data structure here
    .then(args => promise_user_list_data_for_rendering(args))

    .then(function(args){
      let
        company = args[0],
        users_info = args[1];

      if ( req.query['as-csv'] ) {
        return users_list_as_csv({
          users_info : users_info,
          company    : company,
          req        : res,
          res        : res,
        });
      }

      res.render('users', {
        company       : company,
        department_id : Number(department_id),
        title         : company.name + "'s people",
        users_info    : users_info,
      });
    });
});

function promise_user_list_data_for_rendering(args) {
  let
    company = args[0],
    users_info = args[1];

  const usersInfoForRendering = users_info.map(ui => ({
    user_id                               : ui.user_row.id,
    user_email                            : ui.user_row.email,
    user_name                             : ui.user_row.name,
    user_lastname                         : ui.user_row.lastname,
    user_full_name                        : ui.user_row.full_name(),
    department_id                         : ui.user_row.department.id,
    department_name                       : ui.user_row.department.name,
    is_admin                              : ui.user_row.admin,
    number_of_days_available_in_allowance : ui.number_of_days_available_in_allowance,
    number_of_days_taken_from_allowance   : ui.user_row.calculate_number_of_days_taken_from_allowance(),
    is_active                             : ui.user_row.is_active(),
  }));

  const sortedUsersInfoForRendering = usersInfoForRendering
    .sort((a, b) => sorter(a.user_lastname, b.user_lastname));

  return Promise.resolve([company, sortedUsersInfoForRendering]);
}

function users_list_as_csv(args) {
  let users_info = args.users_info,
      company = args.company,
      res = args.res;

  // Compose file name
  res.attachment(
    company.name_for_machine()
      + '_employees_on_'
      + company.get_today().format('YYYY_MMM_DD')
      + '.csv'
  );

  // Compose result CSV header
  let content = [['email', 'lastname', 'name', 'department', 'remaining allowance', 'days used']];

  // ... and body
  users_info.forEach(ui => {
    content.push([
      ui.user_email,
      ui.user_lastname,
      ui.user_name,
      ui.department_name,
      ui.number_of_days_available_in_allowance,
      ui.number_of_days_taken_from_allowance
    ]);
  });

  return csv.stringifyAsync( content )
    .then(csv_data_string => res.send(csv_data_string));
}

function get_and_validate_user_parameters(args) {
    var req         = args.req,
        item_name   = args.item_name,
        require_password = args.require_password || false;

    // Get user parameters
    var name     = validator.trim(req.body['name']),
        lastname = validator.trim(req.body['lastname']),
        email    = validator.trim(req.body['email_address']),
        department_id     = validator.trim(req.body['department']),
        start_date        = validator.trim(req.body['start_date']),
        end_date          = validator.trim(req.body['end_date']),
        adjustment        = validator.trim(req.body['adjustment']),
        password          = validator.trim(req.body['password_one']),
        password_confirm  = validator.trim(req.body['password_confirm']),
        admin             = validator.toBoolean(req.body['admin']),
        auto_approve      = validator.toBoolean(req.body['auto_approve']);

    // Validate provided parameters

    if (!validator.isEmail(email)) {
        req.session.flash_error(
            'New email of '+item_name+' should be valid email address'
        );
    }

    if (!validator.isNumeric(department_id)) {
        req.session.flash_error(
            'New department number of '+item_name+' should be a valid number'
        );
    }

    if (adjustment && ! validator.isFloat(adjustment) ) {
      req.session.flash_error(
        'New allowance adjustment of '+item_name+' should be a valid number'
      );
    } else if (adjustment && ! ( adjustment % 1 === 0 || Math.abs( adjustment % 1 ) === 0.5 )) {
      req.session.flash_error(
        'New allowance adjustment of '+item_name+' should be either whole integer number or with half'
      );
    }

    start_date = req.user.company.normalise_date( start_date );

    if (!validator.isDate(start_date)) {
      req.session.flash_error(
        'New start date for '+item_name+' should be valid date'
      );
    }

    if (end_date ){

      end_date = req.user.company.normalise_date( end_date );

      if ( ! validator.isDate(end_date)) {
        req.session.flash_error(
          'New end date for '+item_name+' should be valid date'
        );
      }
    }

    if (
        start_date &&
        end_date &&
        moment.utc(start_date).toDate() > moment.utc(end_date).toDate()
    ){
        req.session.flash_error(
            'End date for '+item_name+' is before start date'
        );
    }

    if (password && password !== password_confirm) {
      req.session.flash_error('Confirmed password does not match initial one');
    }

    if (require_password && ! password) {
      req.session.flash_error('Password is required');
    }

    if ( req.session.flash_has_errors() ) {
        throw new Error( 'Got validation errors' );
    }

    // Normalize email as we operate only with lower case letters in emails
    email = email.toLowerCase();

    var attributes = {
        name         : name,
        lastname     : lastname,
        email        : email,
        DepartmentId : department_id,
        start_date   : start_date,
        end_date     : (end_date || null),
        admin        : admin,
        auto_approve : auto_approve,
    };

    if (adjustment || String(adjustment) === '0') {
      attributes.adjustment = adjustment;
    }

    if ( password ) {
      attributes.password = password;
    }

    return attributes;
}

function ensure_user_id_is_integer(args){
    var req     = args.req,
        user_id = args.user_id;

    if (! validator.isInt(user_id)){
        throw new Error(
          'User '+req.user.id+' tried to edit user with non-integer ID: '+user_id
        );
    }

    return;
}

module.exports = router;
