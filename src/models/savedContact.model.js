import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const savedContactSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    secondaryPhone: { type: String, trim: true, default: '' },
    description: { type: String, trim: true, default: '' },
    email: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

savedContactSchema.index({ user: 1, phone: 1 });
savedContactSchema.index({ user: 1, name: 1 });

savedContactSchema.plugin(toJSON);
savedContactSchema.plugin(paginate);

const SavedContact = mongoose.model('SavedContact', savedContactSchema);
export default SavedContact;
