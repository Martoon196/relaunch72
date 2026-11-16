import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeFfprobe,VIDEO_PROBE_VERSION} from '../src/creative-studio/media-source-probe.js';

const valid={format:{duration:'130.10'},streams:[
 {codec_type:'video',codec_name:'h264',width:1920,height:1080,avg_frame_rate:'30000/1001'},
 {codec_type:'audio',codec_name:'aac'}]};
test('ffprobe parser reports measured source metadata without inventing rights',()=>{
  assert.deepEqual(decodeFfprobe(valid),{
    status:'verified_technical',checkerVersion:VIDEO_PROBE_VERSION,
    durationMs:130100,width:1920,height:1080,frameRate:29.97,videoCodec:'h264',audioPresent:true});
});
test('rejects multi-video, invalid duration, codec, dimensions and fabricated frames',()=>{
  for(const p of [
    {...valid,format:{duration:'NaN'}},
    {...valid,streams:[valid.streams[0],valid.streams[0]]},
    {...valid,streams:[{...valid.streams[0],codec_name:'unknown'}]},
    {...valid,streams:[{...valid.streams[0],width:0}]},
    {...valid,streams:[{...valid.streams[0],width:3840,height:2160}]},
    {...valid,streams:[{...valid.streams[0],width:1920,height:1920}]},
    {...valid,streams:[{...valid.streams[0],avg_frame_rate:'120/1'}]},
    {...valid,streams:[{...valid.streams[0],codec_name:'hevc'}]},
    {format:{duration:'180'},streams:[]},
  ])assert.equal(decodeFfprobe(p).status,'rejected');
});
