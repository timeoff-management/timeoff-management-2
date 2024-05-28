
'use strict';

const models = require('../lib/model/db');

module.exports = {
  up: function (queryInterface, Sequelize) {

    return queryInterface.describeTable('user_allowance_adjustment').then(attributes => {

      if (attributes.adjustment.type === 'DOUBLE') {
        return 1;
      }
      
      return queryInterface
        // Create Temp user_allowance_adjustment based on current model definitiom
        .createTable('UserAllowanceAdjustment_backup', models.UserAllowanceAdjustment.attributes)
        .then(() => queryInterface.sequelize.query(
          'INSERT INTO `UserAllowanceAdjustment_backup` 
(`id`,`year`,`adjustment`,`carried_over_allowance`,`created_at`,`user_id`) SELECT 
`id`,`year`,`adjustment`,`carried_over_allowance`,`created_at`,`user_id` FROM 
`'+models.UserAllowanceAdjustment.tableName+'`'))
        .then(() => queryInterface.dropTable( models.UserAllowanceAdjustment.tableName ))
        .then(() => queryInterface.renameTable('UserAllowanceAdjustment_backup', 
models.UserAllowanceAdjustment.tableName))
    });
  },

  down: function (queryInterface, Sequelize) {
    // No way back!
    //return Promise.resolve();
  }
};

