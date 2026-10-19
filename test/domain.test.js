'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {transitions,canWrite,cursorEncode}=require('../src/server');
test('workflow map exposes only intended state transitions',()=>{assert.deepEqual(transitions.open,['in_progress']);assert.deepEqual(transitions.awaiting_approval,['resolved']);assert.equal(transitions.open.includes('closed'),false)});
test('write permission is limited to Member, Lead, and Admin roles',()=>{assert.equal(canWrite('Viewer'),false);for(const role of ['Member','Lead','Admin'])assert.equal(canWrite(role),true)});
test('pagination cursor encodes stable timestamp and item id',()=>{const value=cursorEncode({created_at:new Date('2026-10-19T00:00:00Z'),id:'work-1'});assert.deepEqual(JSON.parse(Buffer.from(value,'base64url').toString()),['2026-10-19T00:00:00.000Z','work-1'])});
