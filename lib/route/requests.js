'use strict'

const express = require('express')
const router = express.Router()
const Promise = require('bluebird')
const validator = require('validator')
const _ = require('underscore')
const LeaveCollectionUtil = require('../model/leave_collection')()
const EmailTransport = require('../email')
const SlackTransport = require('../slack')

router.get('/', (req, res) => {
  const dbModel = req.app.get('db_model')

  Promise.join(
    req.user
      .promise_my_active_leaves_ever()
      .then(leaves =>
        LeaveCollectionUtil.enrichLeavesWithComments({ leaves, dbModel })
      )
      .then(leaves => LeaveCollectionUtil.promise_to_group_leaves(leaves)),
    req.user
      .promise_leaves_to_be_processed()
      .then(leaves =>
        LeaveCollectionUtil.enrichLeavesWithComments({ leaves, dbModel })
      ),
    (my_leaves_grouped, to_be_approved_leaves) => {
      res.render('requests', {
        my_leaves_grouped,
        to_be_approved_leaves,
        title: 'Requests | TimeOff'
      })
    }
  )
})

function leave_request_action(args) {
  const current_action = args.action
  const leave_action_method = args.leave_action_method
  let was_pended_revoke = false

  return function(req, res) {
    const request_id = validator.trim(req.body.request)

    if (
      typeof request_id !== 'number' &&
      (!request_id || !validator.isNumeric(request_id))
    ) {
      req.session.flash_error('Failed to ' + current_action)
    }

    if (req.session.flash_has_errors()) {
      console.error(
        'Got validation errors on ' + current_action + ' request handler'
      )

      return res.redirect_with_session('../')
    }

    Promise.try(() => req.user.promise_leaves_to_be_processed())
      .then(leaves => {
        const leave_to_process = _.find(
          leaves,
          leave =>
            String(leave.id) === String(request_id) &&
            (leave.is_new_leave() || leave.is_pended_revoke_leave())
        )

        if (!leave_to_process) {
          throw new Error(
            'Provided ID ' +
              request_id +
              'does not correspond to any leave requests to be ' +
              current_action +
              'ed for user ' +
              req.user.id
          )
        }

        was_pended_revoke = leave_to_process.is_pended_revoke_leave()

        return leave_to_process[leave_action_method]({ by_user: req.user })
      })
      .then(processed_leave =>
        processed_leave.reload({
          include: [
            { model: req.app.get('db_model').User, as: 'user' },
            { model: req.app.get('db_model').User, as: 'approver' },
            { model: req.app.get('db_model').LeaveType, as: 'leave_type' }
          ]
        })
      )
      .then(processed_leave => {
        const Email = new EmailTransport()

        return (
          Email.promise_leave_request_decision_emails({
            leave: processed_leave,
            action: current_action,
            was_pended_revoke
          })
            .then(() => Promise.resolve(processed_leave))
            // Fail silently for the user and track the error for the administrator.
            .catch(error => {
              console.error(
                'Failed to send email for the leave request: ' + error,
                error.stack
              )
              return Promise.resolve(processed_leave)
            })
        )
      })
      .then(processed_leave => {
        const Slack = new SlackTransport()

        return (
          Slack.promise_leave_request_decision_slacks({
            leave: processed_leave,
            action: current_action,
            was_pended_revoke
          })
            .then(() => Promise.resolve(processed_leave))
            // Fail silently for the user and track the error for the administrator.
            .catch(error => {
              console.error(
                'Failed to send slack notification for the leave request: ' +
                  error,
                error.stack
              )
              return Promise.resolve(processed_leave)
            })
        )
      })
      .then(processed_leave => {
        req.session.flash_message(
          'Request from ' + processed_leave.user.full_name() + ' was processed'
        )

        return res.redirect_with_session('../')
      })
      .catch(error => {
        console.error(
          'An error occurred when attempting to ' +
            current_action +
            ' leave request ' +
            request_id +
            ' by user ' +
            req.user.id +
            ' Error: ' +
            error,
          error.stack
        )
        req.session.flash_error('Failed to ' + current_action)
        return res.redirect_with_session('../')
      })
  }
}

router.post(
  '/reject/',
  leave_request_action({
    action: 'reject',
    leave_action_method: 'promise_to_reject'
  })
)

router.post(
  '/approve/',
  leave_request_action({
    action: 'approve',
    leave_action_method: 'promise_to_approve'
  })
)

router.post('/cancel/', (req, res) => {
  const request_id = validator.trim(req.body.request)

  Promise.try(() => req.user.promise_cancelable_leaves())
    .then(leaves => {
      const leave_to_cancel = _.find(
        leaves,
        leave => String(leave.id) === String(request_id)
      )

      if (!leave_to_cancel) {
        throw new Error(
          'Given leave request is not amoung those current user can cancel'
        )
      }

      return Promise.resolve(leave_to_cancel)
    })
    .then(leave => leave.promise_to_cancel().then(() => Promise.resolve(leave)))
    .then(leave =>
      leave.reload({
        include: [
          { model: req.app.get('db_model').User, as: 'user' },
          { model: req.app.get('db_model').User, as: 'approver' },
          { model: req.app.get('db_model').LeaveType, as: 'leave_type' }
        ]
      })
    )
    .then(leave => {
      const Email = new EmailTransport()

      return (
        Email.promise_leave_request_cancel_emails({
          leave
        })
          .then(() => Promise.resolve(leave))
          // Fail silently for the user and track the error for the administrator.
          .catch(error => {
            console.error(
              'Failed to send email for the leave request: ' + error,
              error.stack
            )
            return Promise.resolve(leave)
          })
      )
    })
    .then(leave => {
      const Slack = new SlackTransport()

      return (
        Slack.promise_leave_request_cancel_slacks({
          leave
        })
          .then(() => Promise.resolve(leave))
          // Fail silently for the user and track the error for the administrator.
          .catch(error => {
            console.error(
              'Failed to send slack notification for the leave request: ' +
                error,
              error.stack
            )
            return Promise.resolve(leave)
          })
      )
    })
    .then(leave => {
      req.session.flash_message('The leave request was canceled')
    })
    .catch(error => {
      console.log('An error occurred: ' + error, error.stack)
      req.session.flash_error('Failed to cancel leave request')
    })
    .finally(() => res.redirect_with_session('/requests/'))
})

router.post('/revoke/', (req, res) => {
  const request_id = validator.trim(req.body.request)

  // TODO NOTE revoke action now could be made from more then one place,
  // so make sure that user is redirected to correct place

  if (
    typeof request_id !== 'number' &&
    (!request_id || !validator.isNumeric(request_id))
  ) {
    req.session.flash_error('Failed to revoke leave request')
  }

  if (req.session.flash_has_errors()) {
    console.log(
      'Got validation errors when revoking leave request for user ' +
        req.user.id
    )

    return res.redirect_with_session('../')
  }

  Promise
    // Get the Leave object for submitted ID
    .try(() =>
      req.app.get('db_model').Leave.findOne({ where: { id: request_id } })
    )

    // Ensure that current user can act on this Leave object
    .then(requested_leave => {
      // Case when requested Leave is originated from current user
      if (String(requested_leave.user_id) === String(req.user.id)) {
        return Promise.resolve(requested_leave)
      }

      // Case when requested Leave is originated from one of employees
      // current user can manage
      return req.user.promise_users_I_can_manage().then(users => {
        if (users.find(u => String(u.id) === String(requested_leave.user_id))) {
          return Promise.resolve(requested_leave)
        }

        return Promise.resolve()
      })
    })

    .then(leave_to_process => {
      // Ensure that Leave is in status from it could be revoked
      if (!leave_to_process) {
        throw new Error(
          'Provided ID ' +
            request_id +
            ' does not correspond to any leave requests to be revoked by user ' +
            req.user.id
        )
      }

      // Do the action
      return leave_to_process.promise_to_revoke()
    })

    // Ensure that Leave object has all content necessary for sending emails
    .then(processed_leave =>
      processed_leave.reload({
        include: [
          { model: req.app.get('db_model').User, as: 'user' },
          { model: req.app.get('db_model').User, as: 'approver' },
          { model: req.app.get('db_model').LeaveType, as: 'leave_type' }
        ]
      })
    )

    // Send relevant emails
    .then(processed_leave => {
      const Email = new EmailTransport()

      return (
        Email.promise_leave_request_revoke_emails({
          leave: processed_leave
        })
          .then(() => Promise.resolve(processed_leave))
          // Fail silently for the user and track the error for the administrator.
          .catch(error => {
            console.error(
              'Failed to send email for the leave request: ' + error,
              error.stack
            )
            return Promise.resolve(processed_leave)
          })
      )
    })

    // Send relevant slacks
    .then(processed_leave => {
      console.log('Processing SLACK')
      const Slack = new SlackTransport()

      return (
        Slack.promise_leave_request_revoke_slacks({
          leave: processed_leave
        })
          .then(() => Promise.resolve(processed_leave))
          // Fail silently for the user and track the error for the administrator.
          .catch(error => {
            console.error(
              'Failed to send slack notification for the leave request: ' +
                error,
              error.stack
            )
            return Promise.resolve(processed_leave)
          })
      )
    })

    // Deal with next page: where to land and what to show
    .then(processed_leave => {
      req.session.flash_message(
        'You have requested leave to be revoked. ' +
          (processed_leave.is_auto_approve()
            ? ''
            : 'Your supervisor needs to approve it')
      )

      return res.redirect_with_session('../')
    })

    // Deal with issues if any occurs
    .catch(error => {
      console.error(
        'An error occurred when attempting to revoke leave request ' +
          request_id +
          ' by user ' +
          req.user.id +
          ' Error: ',
        error,
        error.stack
      )
      req.session.flash_error('Failed to revoke leave request')
      return res.redirect_with_session('../')
    })
})

module.exports = router
