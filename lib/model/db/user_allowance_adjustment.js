
"use strict";

const moment = require('moment');

module.exports = function(sequelize, DataTypes){
  let UserAllowanceAdjustment = sequelize.define("UserAllowanceAdjustment", {
    year : {
      type         : DataTypes.INTEGER,
      allowNull    : false,
      defaultValue : moment.utc().format('YYYY'),
      comment      : 'Year when adjustment is applied',
    },
    adjustment : {
      type         : DataTypes.DOUBLE,
      allowNull    : false,
      defaultValue : 0,
      comment      : 'Adjustment to allowance in current year',
    },
    carried_over_allowance : {
      type         : DataTypes.DOUBLE,
      allowNull    : false,
      defaultValue : 0,
      comment      : 'Additional allowance to use based on un-used holidays in previous year',
    },
  }, {
    underscored     : true,
    freezeTableName : true,
    timestamps      : true,
    createdAt       : 'created_at',
    updatedAt       : false,
    tableName       : 'user_allowance_adjustment',
    indexes : [{
      fields : [ 'user_id', 'year' ],
      unique : true,
    }],

    classMethods : {
      associate : function(models) {
        UserAllowanceAdjustment.belongsTo(models.User, {
          as         : 'user',
          foreignKey : 'user_id',
        });
      },
    },

  });

  return UserAllowanceAdjustment;
};
