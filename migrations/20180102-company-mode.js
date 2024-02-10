'use strict'

const models = require('../lib/model/db')

module.exports = {
  up: function(queryInterface, Sequelize) {
    return queryInterface.describeTable('Companies').then(function(attributes) {
      if (attributes.hasOwnProperty('mode')) {
        return 1
      }

      return queryInterface.addColumn(
        'Companies',
        'mode',
        models.Company.attributes.mode
      )
    })
  },

  down: function(queryInterface, Sequelize) {
    return queryInterface.removeColumn('Companies', 'mode')
  }
}
