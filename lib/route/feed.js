'use strict'

const express = require('express')
const router = express.Router()
const _ = require('underscore')
const moment = require('moment')
const Promise = require('bluebird')
const ical = require('ical-generator')
const config = require('../config')
const TeamView = require('../model/team_view')

const numberOfFutureMonthsInTeamViewFeed =
  config.get('number_of_future_months_in_team_view_feed') || 6
const numberOfPastMonthsInTeamViewFeed =
  config.get('number_of_past_months_in_team_view_feed') || 2

const { getCommentsForLeave } = require('../model/comment')

router.get('/:token/anniversary.ics', (req, res) => {
  const cal = ical({
    domain: 'timeoff.management'
  })
  const token = req.params.token
  const model = req.app.get('db_model')

  Promise.resolve()
    .then(() =>
      model.UserFeed.find({
        where: { feed_token: token },
        include: [
          {
            model: model.User,
            as: 'user',
            include: [
              {
                model: model.Company,
                as: 'company'
              }
            ]
          }
        ]
      })
    )
    .then(feed => {
      if (!feed) {
        throw new Error('Unknown token provided')
      }

      return model.User.findAll({
        where: {
          company_id: feed.user.company.id,
          $or: [{ end_date: { $lt: new Date() } }, { end_date: null }]
        }
      })
        .then(users => {
          cal.name('anniversary')

          const days = users.map(u => {
            // next one
            const nextOne = new Date(u.start_date)
            const year0 = nextOne.getFullYear()
            const yearNow = new Date().getFullYear()
            nextOne.setFullYear(yearNow)
            const years = yearNow - year0 // moment().diff(u.start_date, 'years');
            return {
              user: u,
              moment: nextOne,
              years
            }
          })

          return days
        })
        .then(days => {
          days.forEach(day => {
            const start = moment.utc(day.moment)
            const end = moment.utc(day.moment)

            cal.createEvent({
              start: start.toDate(),
              end: end.toDate(),
              summary:
                day.user.full_name() +
                ' is ' +
                day.years +
                ' years at the company.',
              allDay: true,
              description: new Buffer(
                JSON.stringify({ years: day.years, name: day.user.full_name() })
              ).toString('base64')
            })
          })

          res.send(cal.toString())
        })
    })
    .catch(err => {
      console.error(err)
      res.status(404).send('N/A')
    })
})

router.get('/:token/ical.ics', (req, res) => {
  const cal = ical({
    domain: 'timeoff.management'
  })
  const token = req.params.token
  const model = req.app.get('db_model')
  let user

  Promise.resolve()
    .then(() =>
      model.UserFeed.findOne({
        where: { feed_token: token },
        include: [
          {
            model: model.User,
            as: 'user',
            include: [
              {
                model: model.Company,
                as: 'company',
                where: {
                  mode: { $ne: model.Company.get_mode_readonly_holidays() }
                }
              }
            ]
          }
        ]
      })
    )
    .then(feed => {
      if (!feed) {
        throw new Error('Unknown token provided')
      }

      user = feed.user

      if (feed.is_calendar()) {
        cal.name(user.full_name() + ' calendar')
        return user
          .promise_calendar({
            year: user.calendar.company.get_today(),
            show_full_year: true
          })
          .then(calendar => {
            cal.name(user.full_name() + ' calendar')

            const days = _.flatten(
              _.map(calendar, cal => cal.as_for_team_view())
            )

            days.forEach(day => {
              day.user = user
            })

            return Promise.resolve(days)
          })
      } else {
        cal.name(`${user.full_name()}'s team whereabout`)

        // Get the list of month deltas in relation to current month, to we can calculate
        // moths for which to build the feed
        const monthDeltas = Array.from(
          Array(numberOfFutureMonthsInTeamViewFeed + 1).keys()
        ).concat(
          Array.from(Array(numberOfPastMonthsInTeamViewFeed).keys()).map(
            i => -1 * (i + 1)
          )
        )

        return Promise.resolve(
          monthDeltas.map(delta =>
            user.company
              .get_today()
              .clone()
              .add(delta, 'months')
              .startOf('month')
          )
        )
          .map(
            month => {
              const team_view = new TeamView({
                user,
                base_date: month
              })

              return team_view.promise_team_view_details().then(details => {
                let days = []

                details.users_and_leaves.forEach(rec => {
                  const user = rec.user
                  rec.days.forEach(day => {
                    day.user = user
                  })
                  days = days.concat(rec.days)
                })

                return Promise.resolve(days)
              })
            },
            { concurrency: 10 }
          )
          .then(arrayOfDays => Promise.resolve(_.flatten(arrayOfDays)))
      }
    })

    .then(async days => {
      for (const day of days) {
        // We care only about days when employee is on leave
        if (!(day.is_leave_morning || day.is_leave_afternoon)) {
          continue
        }

        const start = moment.utc(day.moment)
        const end = moment.utc(day.moment)
        let allDay = false

        if (day.is_leave_morning && day.is_leave_afternoon) {
          start.hour(9).minute(0)
          end.hour(17).minute(0)
          allDay = true
        } else if (!day.is_leave_morning && day.is_leave_afternoon) {
          start.hour(13).minute(0)
          end.hour(17).minute(0)
        } else if (day.is_leave_morning && !day.is_leave_afternoon) {
          start.hour(9).minute(0)
          end.hour(13).minute(0)
        }

        const comments = await getCommentsForLeave({ leave: day.leave_obj })

        cal.createEvent({
          start: start.toDate(),
          end: end.toDate(),
          allDay,
          summary: day.user.full_name() + ' is OOO (out of office)',
          description:
            comments.length > 0
              ? `With comments: ${comments
                  .map(({ comment }) => comment)
                  .join('. ')}`
              : ''
        })
      }

      res.send(cal.toString())
    })
    .catch(error => {
      console.log(`Failed to fetch feed because of: ${error}`)
      res.status(404).send('N/A')
    })
})

module.exports = router
