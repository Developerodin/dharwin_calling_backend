import httpStatus from 'http-status';
import SavedContact from '../models/savedContact.model.js';
import ApiError from '../utils/ApiError.js';
import { normalizePhone } from '../utils/phone.js';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function phonesMatch(a, b) {
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const lastA = da.length >= 10 ? da.slice(-10) : da;
  const lastB = db.length >= 10 ? db.slice(-10) : db;
  return lastA === lastB;
}

function matchContactByPhone(contacts, phone) {
  if (!phone || !Array.isArray(contacts) || contacts.length === 0) return null;
  return (
    contacts.find(
      (contact) =>
        phonesMatch(contact.phone, phone) ||
        (contact.secondaryPhone && phonesMatch(contact.secondaryPhone, phone))
    ) || null
  );
}

async function findContactByPhone(userId, phone) {
  if (!userId || !phone) return null;

  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const exact = await SavedContact.findOne({
    user: userId,
    $or: [{ phone: normalized }, { secondaryPhone: normalized }],
  });
  if (exact) return exact;

  const digits = phoneDigits(normalized);
  if (digits.length < 7) return null;

  const suffix = digits.slice(-10);
  const regex = new RegExp(`${escapeRegex(suffix)}$`);

  return SavedContact.findOne({
    user: userId,
    $or: [{ phone: { $regex: regex } }, { secondaryPhone: { $regex: regex } }],
  });
}

async function listContactsForUser(userId) {
  if (!userId) return [];
  return SavedContact.find({ user: userId }).lean();
}

async function createContact(userId, body) {
  const phone = normalizePhone(body.phone);
  if (!phone) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid phone number');
  }

  const contact = await SavedContact.create({
    user: userId,
    name: body.name.trim(),
    phone,
    secondaryPhone: body.secondaryPhone ? normalizePhone(body.secondaryPhone) || '' : '',
    description: body.description?.trim() || '',
    email: body.email?.trim() || '',
  });

  return contact;
}

async function getContactById(userId, contactId) {
  const contact = await SavedContact.findOne({ _id: contactId, user: userId });
  if (!contact) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Contact not found');
  }
  return contact;
}

async function updateContact(userId, contactId, body) {
  const contact = await getContactById(userId, contactId);

  if (body.name != null) contact.name = body.name.trim();
  if (body.phone != null) {
    const phone = normalizePhone(body.phone);
    if (!phone) throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid phone number');
    contact.phone = phone;
  }
  if (body.secondaryPhone != null) {
    contact.secondaryPhone = body.secondaryPhone ? normalizePhone(body.secondaryPhone) || '' : '';
  }
  if (body.description != null) contact.description = body.description.trim();
  if (body.email != null) contact.email = body.email.trim();

  await contact.save();
  return contact;
}

async function deleteContact(userId, contactId) {
  const contact = await getContactById(userId, contactId);
  await contact.deleteOne();
  return contact;
}

async function listContacts(userId, options = {}) {
  const filter = { user: userId };
  const search = (options.search || '').trim();
  if (search) {
    const regex = new RegExp(escapeRegex(search), 'i');
    filter.$or = [{ name: regex }, { phone: regex }, { secondaryPhone: regex }, { description: regex }];
  }

  const page = Number(options.page) || 1;
  const limit = Math.min(Number(options.limit) || 25, 500);
  const sortBy = options.sortBy === 'name' ? 'name:asc' : 'createdAt:desc';

  return SavedContact.paginate(filter, { page, limit, sortBy });
}

export default {
  createContact,
  getContactById,
  updateContact,
  deleteContact,
  listContacts,
  findContactByPhone,
  matchContactByPhone,
  listContactsForUser,
  phonesMatch,
};
