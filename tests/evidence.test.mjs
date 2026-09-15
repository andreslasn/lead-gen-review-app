import test from 'node:test';
import assert from 'node:assert/strict';
import {findEvidenceMatch} from '../src/evidence.js';

test('prefers email near the selected clinic on a multi-clinic page',()=>{
  const email='shared@example.invalid';
  const text=`Other clinic ${email}\n${'Unrelated text '.repeat(100)}\nSelected Doctor\n${email}`;
  const match=findEvidenceMatch(text,email,{context:['Selected Doctor']});
  assert.equal(match.start,text.lastIndexOf(email));
  assert.equal(text.slice(match.start,match.end),email);
});
test('matches case-insensitively, falls back to sourced excerpt, and leaves absent evidence alone',()=>{
  assert.deepEqual(findEvidenceMatch('X SHARED@example.invalid Y','shared@example.invalid'),{start:2,end:24});
  assert.deepEqual(findEvidenceMatch('Before saved clinic passage after','absent@example.invalid',{quote:'saved clinic passage'}),{start:7,end:27});
  assert.equal(findEvidenceMatch('No matching passage','absent@example.invalid'),null);
  assert.equal(findEvidenceMatch('No matching passage',''),null);
});
