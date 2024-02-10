'use strict'

const crypto = require('crypto')
const _ = require('underscore')
const moment = require('moment')
const Promise = require('bluebird')
const config = require('../../config')
const UserAllowance = require('../user_allowance')
const htmlToText = require('html-to-text')
// User mixins
const withCompanyAwareness = require('../mixin/user/company_aware')
const withAbsenceAwareness = require('../mixin/user/absence_aware')
const Sequelize = require('sequelize')
const Op = Sequelize.Op
const { sorter } = require('../../util')

const LeaveCollectionUtil = require('../leave_collection')()

module.exports = function(sequelize, DataTypes) {
  const instance_methods = get_instance_methods(sequelize)

  withCompanyAwareness.call(instance_methods, sequelize)
  withAbsenceAwareness.call(instance_methods, sequelize)

  const class_methods = get_class_methods(sequelize)

  withAssociations.call(class_methods, sequelize)
  withScopes.call(class_methods, sequelize)

  const User = sequelize.define(
    'User',
    {
      // TODO add validators!
      email: {
        type: DataTypes.STRING,
        allowNull: false
      },
      slack_username: {
        type: DataTypes.STRING,
        defaultValue: '', // Migration will not run without a default value. I don't understand why.
        allowNull: true
      },
      password: {
        type: DataTypes.STRING,
        allowNull: false
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false
      },
      lastname: {
        type: DataTypes.STRING,
        allowNull: false
      },
      activated: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'This flag means that user account was activated, e.g. login'
      },
      admin: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Indicate if account can edit company wide settings'
      },
      auto_approve: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment:
          'Indicate if leave request from current employee are auto approved'
      },
      start_date: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: 'Date employee start to work for company',
        get: function() {
          return moment
            .utc(this.getDataValue('start_date'))
            .format('YYYY-MM-DD')
        }
      },
      end_date: {
        type: DataTypes.DATE,
        allowNull: true,
        defaultValue: null,
        comment: 'Date emplyee stop working for company',
        get: function() {
          const endDate = this.getDataValue('end_date')
          if (!endDate) {
            return endDate
          }

          return moment.utc(endDate).format('YYYY-MM-DD')
        }
      }
    },
    {
      underscored: true,
      indexes: [
        {
          fields: ['company_id']
        },
        {
          fields: ['department_id']
        },
        {
          fields: ['lastname']
        }
      ],
      hooks: {
        beforeDestroy(user, options) {
          sequelize.models.DepartmentSupervisor.destroy({
            where: { user_id: user.id }
          })
          sequelize.models.Leave.destroy({ where: { user_id: user.id } })
          sequelize.models.Schedule.destroy({ where: { user_id: user.id } })
          sequelize.models.Comment.destroy({ where: { by_user_id: user.id } })
          sequelize.models.UserFeed.destroy({ where: { user_id: user.id } })
          sequelize.models.UserAllowanceAdjustment.destroy({
            where: { user_id: user.id }
          })
          sequelize.models.EmailAudit.destroy({ where: { user_id: user.id } })
        }
      }
    }
  )

  Object.assign(User, class_methods)
  Object.assign(User.prototype, instance_methods)

  /*
   * Convenience method that returns an object with definition of User's instance methods.
   *
   * */
  function get_instance_methods(sequelize) {
    return {
      is_my_password: function(password) {
        return (
          sequelize.models.User.hashify_password(password) === this.password
        )
      },

      /*
       * Activate user only when it is inactive.
       * Return promise that gets user's object.
       */
      maybe_activate: function() {
        if (!this.activated) {
          this.activated = true
        }
        return this.save()
      },

      is_admin: function() {
        return this.admin === true
      },

      /*
       * Indicates is leave requests from current user are automatically approved
       */
      is_auto_approve: function() {
        return this.auto_approve === true
      },

      full_name: function() {
        return this.name + ' ' + this.lastname
      },

      /*
       * Indicates if the user is active
       */
      is_active: function() {
        return this.end_date === null || moment(this.end_date).isAfter(moment())
      },

      // TODO VPP: rename this method as its name misleading: it returns all users
      // managed by current users + user itself, so it should be something like
      // "promise_all_supervised_users_plus_me"
      // In fact this method probably have to be ditched in favour of more granular ones
      //
      promise_users_I_can_manage: async function() {
        const self = this

        let users = []

        if (self.is_admin()) {
          // Check if current user is admin, then fetch all users form company
          const company = await self.getCompany({
            scope: ['with_all_users']
          })

          users = company.users
        } else {
          // If current user has any departments under supervision then get
          // all users from those departments plus user himself,
          // if no supervised users an array with only current user is returned
          const departments = await self.promise_supervised_departments()

          users = departments.map(({ users }) => users).flat()
        }

        // Make sure current user is considered as well
        users.push(self)

        // Remove duplicates
        users = _.uniq(users, ({ id }) => id)

        // Order by last name
        users = users.sort((a, b) => sorter(a.lastname, b.lastname))

        return users
      },

      /*
       * Return user's manager, the head of department user belongs to
       *
       * */
      promise_manager: function() {
        return this.getDepartment({
          scope: ['with_manager']
        }).then(department => Promise.resolve(department.manager))
      },

      /*
       *  Return users who could supervise current user, that is those who could
       *  approve its leave requests and who can create leave requests on behalf of
       *  those user.
       *
       * */
      promise_supervisors: function() {
        return this.getDepartment({
          scope: ['with_manager', 'with_supervisors']
        }).then(department =>
          Promise.resolve(
            _.flatten([department.manager, department.supervisors])
          )
        )
      },

      promise_supervised_departments: function() {
        const self = this

        return (
          sequelize.models.DepartmentSupervisor.findAll({
            where: { user_id: self.id }
          })
            // Obtain departments current user supervises as secondary supervisor
            .then(department_supervisors =>
              department_supervisors.map(obj => obj.department_id)
            )
            .then(department_ids => {
              if (!department_ids) {
                department_ids = []
              }

              return sequelize.models.Department.scope(
                'with_simple_users'
              ).findAll({
                where: {
                  [Op.or]: [
                    { id: { [Op.in]: department_ids } },
                    { manager_id: self.id }
                  ]
                }
              })
            })
            .catch(error => {
              console.error(
                'Unable to retrieve DepartmentSupervisor for user_id=' +
                  self.id +
                  ' : ' +
                  error,
                error.stack
              )
              return error
            })
        )
      },

      promise_supervised_users: function() {
        const self = this

        return self.promise_supervised_departments().then(departments =>
          self.sequelize.models.User.findAll({
            where: { department_id: departments.map(d => d.id) }
          })
        )
      },

      // Generate object that represent Employee allowance
      promise_allowance: function(args) {
        args = args || {}
        // Override user to be current one
        args.user = this
        return UserAllowance.promise_allowance(args)
      },

      reload_with_leave_details: function(args) {
        const self = this
        const dbModel = self.sequelize.models

        return Promise.join(
          self
            .promise_my_active_leaves(args)
            .then(leaves =>
              LeaveCollectionUtil.enrichLeavesWithComments({ leaves, dbModel })
            ),
          self.getDepartment(),
          self.promise_schedule_I_obey(),
          (leaves, department, schedule) => {
            self.my_leaves = leaves
            self.department = department

            // Note: we do not do anything with scheduler as "promise_schedule_I_obey"
            // sets the "cached_schedule" attribute under the hood, which is used in
            // synchronous code afterwards. Yes... itaza`z is silly, but it is where we are
            // at thi moment after mixing non blocking and blocking code together...
            //
            return Promise.resolve(self)
          }
        ).catch(error => {
          console.error(
            'Unable to load leaves details for user ' +
              self.email +
              ' : ' +
              error,
            error.stack
          )
          return Promise.reject(error)
        })
      },

      // This method reload user object to have all necessary information to render
      // each page
      reload_with_session_details: function() {
        const self = this

        return Promise.join(
          self.promise_users_I_can_manage(),
          self.get_company_with_all_leave_types(),
          self.promise_schedule_I_obey(),
          (users, company, schedule) => {
            self.supervised_users = users || []
            self.company = company

            // Note: we do not do anything with scheduler as "promise_schedule_I_obey"
            // sets the "cached_schedule" attribute under the hood, which is used in
            // synchronous code afterwards. Yes... it is silly, but it is where we are
            // at thi moment after mixing non blocking and blocking code together...

            return Promise.resolve(self)
          }
        ).catch(error => {
          console.error(
            'Unable to load session details for user ' +
              self.email +
              ' : ' +
              error,
            error.stack
          )
          return Promise.reject(error)
        })
      },

      remove: function() {
        const self = this

        // make sure I am not admin, otherwise throw an error
        if (self.is_admin()) {
          throw new Error('Cannot remove administrator user')
        }

        // make sure I am not supervisor, otherwise throw an error
        return (
          self
            .promise_supervised_departments()
            .then(departments => {
              if (departments.length > 0) {
                throw new Error('Cannot remove supervisor')
              }

              return self.getMy_leaves()
            })
            .then(leaves =>
              // remove all leaves
              Promise.all(_.map(leaves, leave => leave.destroy()))
            )

            // remove user record
            .then(() => self.destroy())
        )
      },

      get_reset_password_token: function() {
        const self = this

        return Buffer.from(
          self.email +
            ' ' +
            this.sequelize.models.User.hashify_password(self.password)
        ).toString('base64')
      },

      // Accept an object that represent email to be sent to current user and
      // record it into the corresponding audit table
      //
      record_email_addressed_to_me: function(email_obj) {
        // validate email object to contain all necessary fields
        if (
          !email_obj ||
          !email_obj.hasOwnProperty('subject') ||
          !email_obj.subject ||
          !email_obj.hasOwnProperty('body') ||
          !email_obj.body
        ) {
          throw new Error(
            'Got incorrect parameters. There should be an object ' +
              'to represent and email and contain subject and body'
          )
        }

        const promise_action = this.sequelize.models.EmailAudit.create({
          email: this.email,
          subject: htmlToText.fromString(email_obj.subject),
          body: htmlToText.fromString(email_obj.body),
          user_id: this.id,
          company_id: this.company_id
        })

        return promise_action
      },

      promise_schedule_I_obey: function() {
        const self = this

        if (self.cached_schedule) {
          return Promise.resolve(self.cached_schedule)
        }

        return self.sequelize.models.Schedule.findAll({
          where: {
            [Op.or]: [{ user_id: self.id }, { company_id: self.company_id }]
          }
        }).then(schedules => {
          // no schedules for current user in DB, return default one
          if (schedules.length === 0) {
            return self.sequelize.models.Schedule.promise_to_build_default_for({
              company_id: self.company_id
            }).then(sch => {
              self.cached_schedule = sch
              return Promise.resolve(sch)
            })
          }

          // there are two schedules, presumably one company wide and another
          // is user specific, return later one
          if (schedules.length === 2) {
            return Promise.resolve(
              _.find(schedules, sch => sch.is_user_specific())
            ).then(sch => {
              self.cached_schedule = sch
              return Promise.resolve(sch)
            })
          }

          // single schedule means it is company wide one
          return Promise.resolve(schedules.pop()).then(sch => {
            self.cached_schedule = sch
            return Promise.resolve(sch)
          })
        })
      }
    }
  }

  function get_class_methods(sequelize) {
    return {
      /* hashify_password( password_string ) : string
       *
       * For provided string return hashed string.
       *
       * */
      hashify_password: function(password) {
        return crypto
          .createHash('md5')
          .update(
            password + config.get('crypto_secret'),
            config.get('crypto_hash_encoding') || 'binary'
          )
          .digest('hex')
      },

      get_user_by_reset_password_token: function(token) {
        const self = this
        const unpacked_token = Buffer.from(token, 'base64').toString('ascii')
        const email_and_hashed_password = unpacked_token.split(/\s/)

        return self.find_by_email(email_and_hashed_password[0]).then(user => {
          if (
            user &&
            self.hashify_password(user.password) ===
              email_and_hashed_password[1]
          ) {
            return Promise.resolve(user)
          } else {
            return Promise.resolve()
          }
        })
      },

      // Get active user by provided email address
      find_by_email: function(email) {
        // TODO validate email

        const condition = { email }
        const active_users_filter = this.get_active_user_filter()
        for (const attrname in active_users_filter) {
          condition[attrname] = active_users_filter[attrname]
        }

        return this.findOne({ where: condition })
      },

      find_by_id: function(id) {
        return this.findOne({ where: { id } })
      },

      /*
       * Create new admin user within new environment - company etc
       * */
      register_new_admin_user: function(attributes) {
        // TODO add parameters validation

        // Make sure we hash the password before storing it to DB
        attributes.password = this.hashify_password(attributes.password)

        let new_departments
        let new_user
        const country_code = attributes.country_code
        const timezone = attributes.timezone
        const company_name = attributes.company_name

        delete attributes.company_name
        delete attributes.country_code

        return (
          sequelize.models.User.find_by_email(attributes.email)
            .then(existing_user => {
              if (existing_user) {
                const error = new Error('Email is already used')
                error.show_to_user = true
                throw error
              }

              if (attributes.name.toLowerCase().indexOf('http') >= 0) {
                const error = new Error('Name cannot have links')
                error.show_to_user = true
                throw error
              }

              return sequelize.models.Company.create_default_company({
                name: company_name,
                country_code,
                timezone
              })
            })

            // Make sure new user is going to be linked with a company
            .then(company => {
              attributes.company_id = company.id
              attributes.admin = true

              return company.getDepartments()
            })

            // Make sure new user is linked with department
            .then(departments => {
              new_departments = departments

              attributes.department_id = departments[0].id

              return sequelize.models.User.create(attributes)
            })

            // Make sure new departments know who is their manager
            .then(user => {
              new_user = user

              return Promise.all(
                _.map(new_departments, department => {
                  department.manager_id = user.id
                  return department.save()
                })
              )
            })

            // Return promise with newly created user
            .then(() => Promise.resolve(new_user))
        )
      },

      get_active_user_filter: function() {
        return {
          [Op.or]: [
            { end_date: { [Op.eq]: null } },
            {
              end_date: {
                [Op.gte]: moment
                  .utc()
                  .startOf('day')
                  .format('YYYY-MM-DD')
              }
            }
          ]
        }
      }
    }
  } // END of class methods

  // Mixin-like function that injects definition of User's associations into supplied object.
  // (Define relations between User class and other entities in the domain).
  //
  function withAssociations() {
    this.associate = function(models) {
      models.User.belongsTo(models.Company, {
        as: 'company',
        foreignKey: { name: 'company_id', allowNull: false }
      })
      models.User.belongsTo(models.Department, {
        as: 'department',
        foreignKey: { name: 'department_id', allowNull: false }
      })
      models.User.hasMany(models.Leave, {
        as: 'my_leaves',
        foreignKey: { name: 'user_id', allowNull: false }
      })
      models.User.hasMany(models.UserFeed, {
        as: 'feeds',
        foreignKey: { name: 'user_id', allowNull: false }
      })
      models.User.hasMany(models.UserAllowanceAdjustment, {
        as: 'adjustments',
        foreignKey: { name: 'user_id', allowNull: false }
      })
    }
  }

  function withScopes() {
    this.loadScope = function(models) {
      models.User.addScope('active', () => ({
        where: models.User.get_active_user_filter()
      }))

      models.User.addScope('withDepartments', () => ({
        include: [
          {
            model: models.Department,
            as: 'department'
          }
        ]
      }))

      models.User.addScope('with_simple_leaves', () => ({
        include: [
          {
            model: models.Leave,
            as: 'my_leaves',
            where: {
              $and: [
                { status: { $ne: models.Leave.status_rejected() } },
                { status: { $ne: models.Leave.status_canceled() } }
              ]
            }
          }
        ]
      }))
    }
  }

  return User
}
