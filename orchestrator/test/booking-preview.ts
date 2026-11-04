import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {ownerCalendar,publicSlots} from '../src/booking/view.js';
import {defaultMeetingType,founderSchedule} from '../src/booking/service.js';
import {appShell} from '../src/portal/ui.js';
import {MARTIN_HOWARD_PROPERTY_PROFILE} from '../src/portal/product-profile.js';
const folder=process.env.BOOKING_PREVIEW_OUTPUT;if(!folder)throw Error('Explicit preview folder required');
const type={...defaultMeetingType(),published:true},snapshot={workspaceId:type.id,calendar:{version:1,schedule:founderSchedule(),hostId:type.id,connected:true},types:[{...type,archived:false}],meetings:[]};
const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});
 const html=appShell({title:'Growth HQ calendar',tenantName:'Martin Howard Property',active:'investors',mode:'crm',productProfile:MARTIN_HOWARD_PROPERTY_PROFILE,body:ownerCalendar(snapshot,'preview','https://example.invalid',new URLSearchParams('view=hours'))});
 await page.setContent(html);await page.screenshot({path:folder+'/booking-owner-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.setContent(publicSlots({type,schedule:founderSchedule(),calendarVersion:1,busy:[],brandName:'Martin Howard Property',accentColor:'#E8A33D',connected:true},'2026-11-05',[{start:'2026-11-05T20:40:00.000Z',end:'2026-11-05T21:00:00.000Z'}],'preview','2026-11-05T20:40:00.000Z'));
 if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error('Mobile booking page overflows');
 await page.screenshot({path:folder+'/booking-public-mobile.png',fullPage:true});
 console.log('Desktop hours and mobile booking rendered; mobile overflow check passed.');
}finally{await browser.close();}
