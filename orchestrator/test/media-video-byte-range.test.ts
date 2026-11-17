import test from 'node:test';
import assert from 'node:assert/strict';
import {videoByteRange} from '../src/portal/media-video-byte-range.js';
test('private video stream serves only a strict bounded byte interval',()=>{
  assert.deepEqual(videoByteRange(undefined,100),{kind:'full'});
  assert.deepEqual(videoByteRange('bytes=0-9',100),{kind:'partial',start:0,end:9});
  assert.deepEqual(videoByteRange('bytes=9-',100),{kind:'partial',start:9,end:99});
  assert.deepEqual(videoByteRange('bytes=-10',100),{kind:'partial',start:90,end:99});
  assert.deepEqual(videoByteRange('bytes=0-999',100),{kind:'partial',start:0,end:99});
  for(const bad of ['bytes=20-10','bytes=100-200','bytes=','bytes=-0','bytes=0-5,8-10','bytes=999999999999999999-','items=0-9'])
    assert.deepEqual(videoByteRange(bad,100),{kind:'invalid'},bad);
});
