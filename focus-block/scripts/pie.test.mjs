import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pieSlices } from '../options/pie.js';
test('pie keeps top seven and sums every remaining site into Others', () => {
  const sites = Array.from({length:10}, (_,i)=>({domain:`site${i}.com`,seconds:i+1}));
  const slices = pieSlices(sites);
  assert.equal(slices.length,8);
  assert.equal(slices[0].domain,'site9.com');
  assert.deepEqual(slices.at(-1),{domain:'Others',seconds:6,count:3,others:true});
  assert.equal(slices.reduce((sum,s)=>sum+s.seconds,0),55);
  assert.equal(sites[0].domain,'site0.com');
});
test('empty, zero and single-site datasets do not invent Others', () => {
  assert.deepEqual(pieSlices([]),[]);
  assert.deepEqual(pieSlices([{domain:'zero.com',seconds:0}]),[]);
  assert.equal(pieSlices([{domain:'one.com',seconds:5}]).length,1);
  assert.equal(pieSlices([{domain:'bad.com',seconds:NaN}]).length,0);
});
