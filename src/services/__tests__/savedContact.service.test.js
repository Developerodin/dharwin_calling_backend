import { test } from 'node:test';
import assert from 'node:assert/strict';

import savedContactService from '../savedContact.service.js';

const { phonesMatch, matchContactByPhone } = savedContactService;

test('phonesMatch compares exact and last-10-digit numbers', () => {
  assert.equal(phonesMatch('+919876543210', '9876543210'), true);
  assert.equal(phonesMatch('+15551234567', '+15551234567'), true);
  assert.equal(phonesMatch('+919876543210', '+918765432109'), false);
});

test('matchContactByPhone finds saved contact by primary or secondary phone', () => {
  const contacts = [
    { _id: '1', name: 'Alice', phone: '+919876543210', secondaryPhone: '' },
    { _id: '2', name: 'Bob', phone: '+15550001111', secondaryPhone: '+15550002222' },
  ];

  assert.equal(matchContactByPhone(contacts, '9876543210')?.name, 'Alice');
  assert.equal(matchContactByPhone(contacts, '+15550002222')?.name, 'Bob');
  assert.equal(matchContactByPhone(contacts, '+19999999999'), null);
});
