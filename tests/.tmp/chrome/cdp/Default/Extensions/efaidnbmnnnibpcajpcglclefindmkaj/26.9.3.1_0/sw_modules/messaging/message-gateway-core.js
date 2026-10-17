/*************************************************************************
* ADOBE CONFIDENTIAL
* ___________________
*
*  Copyright 2015 Adobe Systems Incorporated
*  All Rights Reserved.
*
* NOTICE:  All information contained herein is, and remains
* the property of Adobe Systems Incorporated and its suppliers,
* if any.  The intellectual and technical concepts contained
* herein are proprietary to Adobe Systems Incorporated and its
* suppliers and are protected by all applicable intellectual property laws,
* including trade secret and or copyright laws.
* Dissemination of this information or reproduction of this material
* is strictly forbidden unless prior written permission is obtained
* from Adobe Systems Incorporated.
**************************************************************************/
import{getContract as e}from"./message-registry.js";import{BUS as n,DECISION as t}from"./messaging-constants.js";import{describeTargetEndpoint as i,isEndpointPermitted as r}from"./mediation-helpers.js";import{startTiming as o,endTiming as s}from"./gateway-perf-core.js";function d(e){return{bus:e,op:void 0,decision:void 0,path:"bypass"}}let a=!1;function c(e){a||(a=!0,console.error("DCBrowserExt:Messaging:PerfTimingError",e))}function p(e){try{return e()}catch(e){return void c(e)}}function m(e,n,t){try{e(n,t)}catch(e){c(e)}}async function u({op:e,contract:n,request:r,sender:o,discriminatorField:s,endpoint:d,mediateFn:a,reportRejectionFn:c}){const p=n?.bus;try{const{decision:n}=await a({busId:p,op:e,envelopeFields:[s],request:r,sender:o,endpoint:d});return n}catch(r){return c({bus:p,op:e,tier:null,endpoint:i(n?.targetEndpoint),reason:`mediateFn threw: ${r?.message||r}`,timestamp:Date.now()}),t.REJECTED}}export function wrapRuntimeMessageListener(i,a,{mediateFn:c,endpoint:g,reportRejectionFn:F,startTiming:T=o,endTiming:f=s}){return function(o,s,E){const R=p(T);if(void 0!==o?.dcMsgOp)return;const j=o?.[i];if(void 0===j)return m(f,R,d(n.RUNTIME_MESSAGE)),a(o,s,E);const M={...o},l=e(j);return!l||void 0===g||r(g,l.targetEndpoint)?(u({op:j,contract:l,request:M,sender:s,discriminatorField:i,endpoint:g,mediateFn:c,reportRejectionFn:F}).then(e=>{m(f,R,{bus:l?.bus,op:j,decision:e,path:"mediated"}),e!==t.REJECTED&&a(M,s,E)}),!0):void 0}}export function registerRuntimeMessageHandler(e,n,{endpoint:t,mediateFn:i,reportRejectionFn:r,startTiming:o,endTiming:s}){const d={mediateFn:i,endpoint:t,reportRejectionFn:r,startTiming:o,endTiming:s};chrome.runtime.onMessage.addListener(wrapRuntimeMessageListener(e,n,d))}export function wrapPortMessageListener(i,a,{mediateFn:c,endpoint:g,reportRejectionFn:F,startTiming:T=o,endTiming:f=s}){return function(o,s){const E=p(T),R=o?.[i];if(void 0===R)return m(f,E,d(n.RUNTIME_CONNECT)),a(o,s);const j=e(R);j&&void 0!==g&&!r(g,j.targetEndpoint)||u({op:R,contract:j,request:o,sender:s.sender,discriminatorField:i,endpoint:g,mediateFn:c,reportRejectionFn:F}).then(e=>{m(f,E,{bus:j?.bus,op:R,decision:e,path:"mediated"}),e!==t.REJECTED&&a(o,s)})}}export function registerPortMessageHandler(e,n,t,{endpoint:i,mediateFn:r,reportRejectionFn:o,startTiming:s,endTiming:d}){const a={mediateFn:r,endpoint:i,reportRejectionFn:o,startTiming:s,endTiming:d};e.onMessage.addListener(wrapPortMessageListener(n,t,a))}