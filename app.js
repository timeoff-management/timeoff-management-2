const express = require('express')
const path = require('path')
const favicon = require('serve-favicon')
const logger = require('morgan')
const cookieParser = require('cookie-parser')
const bodyParser = require('body-parser')
const moment = require('moment')
const _handlebars = require('handlebars')
const {
  allowInsecurePrototypeAccess
} = require('@handlebars/allow-prototype-access')

const app = express()

// Handlebars
//
// Secure if only developers have access to the templates
// https://stackoverflow.com/questions/59690923/handlebars-access-has-been-denied-to-resolve-the-property-from-because-it-is

// View engine setup
const handlebars = require('express-handlebars').create({
  defaultLayout: 'main',
  extname: '.hbs',
  helpers: require('./lib/view/helpers')(),
  handlebars: allowInsecurePrototypeAccess(_handlebars)
})

app.engine('.hbs', handlebars.engine)
app.set('view engine', '.hbs')

// Add single reference to the model into application object
// and reuse it whenever an access to DB is needed
app.set('db_model', require('./lib/model/db'))

// uncomment after placing your favicon in /public
// app.use(favicon(__dirname + '/public/favicon.ico'));
app.use(logger('dev'))
app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: false }))
app.use(cookieParser())
app.use(express.static(path.join(__dirname, 'public')))

// Setup authentication mechanism
const passport = require('./lib/passport')()

const session = require('express-session')
// initalize sequelize with session store
const SequelizeStore = require('connect-session-sequelize')(session.Store)
app.use(
  session({
    secret: 'my dirty secret ;khjsdkjahsdajhasdam,nnsnad,',
    resave: false,
    saveUninitialized: false,
    store: new SequelizeStore({
      db: app.get('db_model').sequelize
    })
  })
)
app.use(passport.initialize())
app.use(passport.session())

// Custom middlewares
//
// Make sure session and user objects are available in templates
app.use(function(req, res, next) {
  // Get today given user's timezone
  let today

  if (req.user && req.user.company) {
    today = req.user.company.get_today()
  } else {
    today = moment.utc()
  }

  res.locals.session = req.session
  res.locals.logged_user = req.user
  res.locals.url_to_the_site_root = '/'
  res.locals.requested_path = req.originalUrl
  // For book leave request modal
  res.locals.booking_start = today
  res.locals.booking_end = today
  res.locals.keep_team_view_hidden = !!(
    req.user &&
    req.user.company.is_team_view_hidden &&
    !req.user.admin
  )

  next()
})

app.use(function(_req, res, next) {
  res.locals.custom_java_script = [
    '/js/bootstrap-datepicker.js',
    '/js/global.js'
  ]
  res.locals.custom_css = ['/css/bootstrap-datepicker3.standalone.css']
  next()
})

// Enable flash messages within session
app.use(require('./lib/middleware/flash_messages'))

app.use(require('./lib/middleware/session_aware_redirect'))

// Here will be publicly accessible routes

app.use('/feed/', require('./lib/route/feed'))

app.use('/integration/v1/', require('./lib/route/integration_api')(passport))

app.use(
  '/',
  require('./lib/route/login')(passport),

  // All rotes bellow are only for authenticated users
  require('./lib/route/dashboard')
)

app.use('/api/v1/', require('./lib/route/api'))

app.use('/calendar/', require('./lib/route/calendar'))

app.use('/settings/', require('./lib/route/settings'))

// '/settings/' path is quite big hence there are two modules providing handlers for it
app.use('/settings/', require('./lib/route/departments'))
app.use('/settings/', require('./lib/route/bankHolidays'))

app.use(
  '/users/',
  // Order of following requires for /users/ matters
  require('./lib/route/users/summary'),
  require('./lib/route/users')
)

app.use('/requests/', require('./lib/route/requests'))

app.use('/audit/', require('./lib/route/audit'))

app.use('/reports/', require('./lib/route/reports'))

// catch 404
app.use(function(req, res, next) {
  res.render('not_found')
})

// error handlers

// development error handler
// will print stacktrace
if (app.get('env') === 'development') {
  app.use(function(err, req, res, next) {
    console.error(err)
    res.status(err.status || 500)
    res.render('error', {
      message: err.message,
      error: err
    })
  })
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
  console.error(err)
  res.status(err.status || 500)
  res.render('error', {
    message: err.message,
    error: {}
  })
})

module.exports = app
