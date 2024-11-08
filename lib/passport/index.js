
/*
 *  Module to encapsulate logic for passport instantiation used for
 *  authentication.
 *
 *  Exports function that return instance of passport object.
 *
 * */

'use strict';

const
  model     = require('../model/db'),
  passport      = require('passport'),
  Promise       = require('bluebird'),
  LocalStrategy = require('passport-local').Strategy,
  BearerStrategy= require('passport-http-bearer').Strategy,
  config              = require('../config'),
  getCompanyAdminByToken = require('./getCompanyAdminByToken');

// In case if user is successfully logged in, make sure it is
// activated
function prepare_user_for_session(args) {
  var user = args.user,
      done = args.done;

  user.maybe_activate()
    .then(function(user){
      return user.reload_with_session_details();
    })
    .then(function(){
      done(null, user);
    });
}

// Function that performs authentication of given user object
// by given password.
// The method is callback based and the result is conveyed
// via provided callback function "done"
//
function authenticate_user(args){

  var user = args.user,
  password = args.password,
  done     = args.done,
  email    = user.email;

  // In case of LDAP authentification connect the LDAP server
  if ( user.company.ldap_auth_enabled ) {

// email = 'euler@ldap.forumsys.com'; password = 'password'; // TODO remove
    Promise.resolve( user.company.get_ldap_server() )
      .then(function(ldap_server){
          ldap_server.authenticate(email, password, function (err, u) {
            if (err) {
              console.log("LDAP auth error: %s", err);
              return done(null, false);
            }
            prepare_user_for_session({
              user : user,
              done : done,
            });    
          });
        ldap_server.close();
      })    
      .catch(function(error){
        console.error('Fail to connect LDAP server, error: %s', error);

        done(null, false);
    });

  // Provided password is correct
  } else if (user.is_my_password(password)) {

    prepare_user_for_session({
      user : user,
      done : done,
    });

  // User exists but provided password does not match
  } else {
      console.error(
        'When login user entered existsing email ' +email+
        ' but incorrect password'
      );
      done(null, false);
  }
}

function strategy_handler(email, password, done) {

  // Normalize email to be in lower case
  email = email.toLowerCase();

  model.User
    .find_by_email( email )
    .then(function(user){

      // Case when no user for provided email
      if ( ! user ) {
        console.error(
          'At login: failed to find user with provided email %s', email
        );

        // We need to abort the execution of current callback function
        // hence the return before calling "done" callback
        return done(null, false);
      }

      // Athenticate user by provided password
      user.getCompany()
        .then(function(company){

          // We need to have company for user fetchef dow the line so query it now
          user.company = company;

          authenticate_user({
            user     : user,
            password : password,
            done     : done,
          });
        });
    })

    // there was unknown error when trying to retrieve user object
    .catch(function(error){
      console.error(
        'At login: unknown error when trying to login in as %s. Error: %s',
        email, error
      );

      done(null, false);
    });
}

module.exports = function(){

  passport.use(new LocalStrategy( strategy_handler ));

  passport.use(new BearerStrategy((token, done) => {
    getCompanyAdminByToken({ token, model })
    .then(user => user.reload_with_session_details())
    .then(user => done(null, user))
    .catch(error => {
      console.log(`Failed to authenticate TOKEN. Reason: '${error}'`);
      done(null, false);
    });
  }));

  // Define how user object is going to be flattered into session
  // after request is processed.
  // In session store we save only user ID
  passport.serializeUser(function(user, done) {
    done(null, user.id);
  });

  // Defines how the user object is restored based on data saved
  // in session storage.
  // Fetch user data from DB based on ID.
  passport.deserializeUser(function(id, done) {

    model.User.find({where : {id : id}}).then(function(user){
      return user.reload_with_session_details();
    })
    .then(function(user){
      done(null, user);
    })
    .catch(function(error){
      console.error('Failed to fetch session user '+id+' with error: '+error);

      done(null, false, { message : 'Failed to fetch session user' });
    });
  });

  return passport;
};
