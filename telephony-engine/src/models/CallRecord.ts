import { DataTypes, Model, Optional } from 'sequelize';
import { sequelize } from '../config/database.js';

interface CallRecordAttributes {
  id: number;
  channelId: string;
  callerId: string | null;
  startTime: Date;
  endTime: Date | null;
  durationSeconds: number | null;
  transcript: string | null;  // JSON array of {role, content} objects
  llmModel: string | null;
}

interface CallRecordCreationAttributes extends Optional<CallRecordAttributes, 'id' | 'endTime' | 'durationSeconds' | 'transcript' | 'llmModel' | 'callerId'> {}

export class CallRecord extends Model<CallRecordAttributes, CallRecordCreationAttributes>
  implements CallRecordAttributes {
  declare id: number;
  declare channelId: string;
  declare callerId: string | null;
  declare startTime: Date;
  declare endTime: Date | null;
  declare durationSeconds: number | null;
  declare transcript: string | null;
  declare llmModel: string | null;
}

CallRecord.init(
  {
    id:              { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    channelId:       { type: DataTypes.STRING(128), allowNull: false },
    callerId:        { type: DataTypes.STRING(64), allowNull: true },
    startTime:       { type: DataTypes.DATE, allowNull: false },
    endTime:         { type: DataTypes.DATE, allowNull: true },
    durationSeconds: { type: DataTypes.INTEGER, allowNull: true },
    transcript:      { type: DataTypes.TEXT('long'), allowNull: true },
    llmModel:        { type: DataTypes.STRING(64), allowNull: true },
  },
  {
    sequelize,
    tableName:  'call_records',
    timestamps: true,
    updatedAt:  false,
  },
);
