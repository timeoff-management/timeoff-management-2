'use strict'

const express = require('express')
const Bluebird = require('bluebird')
const validator = require('validator')
const _ = require('underscore')
const moment = require('moment')
const router = express.Router()
const Pager = require('./utils/pager')()

// Make sure that current user is authorized to deal with settings
router.all(/.*/, require('../middleware/ensure_user_is_admin'))

router.get(/email/, (req, res) => {
  const user_id =
    typeof req.query.user_id !== 'undefined' &&
    validator.toInt(req.query.user_id)
  let start_date =
    typeof req.query.start_date !== 'undefined' &&
    validator.trim(req.query.start_date)
  let end_date =
    typeof req.query.end_date !== 'undefined' &&
    validator.trim(req.query.end_date)
  const page =
    (typeof req.query.page !== 'undefined' &&
      validator.toInt(req.query.page)) ||
    1
  const model = req.app.get('db_model')
  const filter = {
    company_id: req.user.company_id
  }

  const items_per_page = Pager.items_per_page

  if (start_date) start_date = req.user.company.normalise_date(start_date)

  // if there is a valid start date provided pass it to the filter
  if (start_date && validator.toDate(start_date)) {
    if (!filter.hasOwnProperty('created_at')) filter.created_at = {}
    filter.created_at.$gte = start_date
  }

  // ... same for end date

  if (end_date) end_date = req.user.company.normalise_date(end_date)

  if (end_date && validator.toDate(end_date)) {
    if (!filter.hasOwnProperty('created_at')) filter.created_at = {}
    filter.created_at.$lte = end_date
  }

  if (typeof user_id === 'number' || (user_id && validator.isInt(user_id))) {
    filter.user_id = user_id
  }

  const promise_emails = model.EmailAudit.findAndCountAll({
    where: filter,

    limit: items_per_page,
    offset: items_per_page * (page - 1),
    order: [['id', 'DESC']],

    include: [
      {
        model: model.User,
        as: 'user'
      }
    ]
  })

  const promise_all_users = model.User.findAll({
    where: {
      company_id: req.user.company_id
    },
    order: [['lastname']]
  })

  Bluebird.join(
    promise_emails,
    promise_all_users,
    (email_result, all_users) => {
      const filter = {
        user_id
      }

      if (start_date) {
        filter.start_date = moment
          .utc(start_date)
          .format(req.user.company.get_default_date_format())
      }

      if (end_date) {
        filter.end_date = moment
          .utc(end_date)
          .format(req.user.company.get_default_date_format())
      }

      res.render('audit/emails', {
        audit_emails: email_result.rows,
        all_users,
        filter,
        show_reset_button: _.some([user_id, start_date, end_date]),
        pager: Pager.get_pager_object({
          filter,
          total_items_count: email_result.count,
          current_page: page
        }),
        title: 'Email Audit | TimeOff'
      })
    }
  )
})

module.exports = router
