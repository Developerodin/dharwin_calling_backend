import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const callRecordingSchema = new mongoose.Schema(
  {
    call: { type: mongoose.Schema.Types.ObjectId, ref: 'Call', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    callSid: { type: String, required: true, index: true },
    recordingSid: { type: String, required: true, unique: true, index: true },
    recordingUrl: { type: String, default: null },
    duration: { type: Number, default: 0 },
    status: { type: String, default: 'processing', index: true },
    channels: { type: Number, default: 1 },
    raw: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: 'plivocallrecordings' }
);

callRecordingSchema.index({ user: 1, createdAt: -1 });

callRecordingSchema.plugin(toJSON);
callRecordingSchema.plugin(paginate);

const CallRecording = mongoose.model('CallRecording', callRecordingSchema);
export default CallRecording;
