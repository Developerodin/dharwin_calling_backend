import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const callReportSchema = new mongoose.Schema(
  {
    call: { type: mongoose.Schema.Types.ObjectId, ref: 'Call', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    contact: { type: mongoose.Schema.Types.ObjectId, ref: 'SavedContact', default: null },
    callSid: { type: String, required: true, index: true },
    callerNumber: { type: String, trim: true, default: '' },
    receiverNumber: { type: String, trim: true, default: '' },
    callDuration: { type: Number, default: 0 },
    callStatus: { type: String, default: 'unknown', index: true },
    recordingUrl: { type: String, default: null },
    recordingDuration: { type: Number, default: null },
    transcriptSid: { type: String, default: null },
    summary: { type: String, default: null },
    transcript: { type: String, default: null },
    summaryStatus: { type: String, default: 'unavailable', index: true },
    callStartTime: { type: Date, default: null },
    callEndTime: { type: Date, default: null },
    generatedAt: { type: Date, default: Date.now, index: true },
    providerResponse: { type: mongoose.Schema.Types.Mixed, default: {} },
    twilioResponse: { type: mongoose.Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true, collection: 'plivocallreports' }
);

callReportSchema.index({ user: 1, generatedAt: -1 });
callReportSchema.index({ callSid: 1 }, { unique: true });

callReportSchema.options.toJSON = {
  ...(callReportSchema.options.toJSON || {}),
  transform(_doc, ret) {
    if (!ret.providerResponse && ret.twilioResponse) {
      ret.providerResponse = ret.twilioResponse;
    }
    if (ret.providerResponse) {
      ret.twilioResponse = ret.providerResponse;
    }
    return ret;
  },
};

callReportSchema.plugin(toJSON);
callReportSchema.plugin(paginate);

const CallReport = mongoose.model('CallReport', callReportSchema);
export default CallReport;
