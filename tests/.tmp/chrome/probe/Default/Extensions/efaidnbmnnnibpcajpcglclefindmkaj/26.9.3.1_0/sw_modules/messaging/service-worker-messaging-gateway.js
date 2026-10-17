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
import{resolveMode as e}from"./op-migration-state.js";import{loggingApi as n}from"../../common/loggingApi.js";import{mediate as t}from"./mediation-pipeline.js";import{startGatewayPerf as r,startTiming as i,endTiming as s}from"./gateway-perf.js";import{wrapRuntimeMessageListener as o,wrapPortMessageListener as a}from"./message-gateway-core.js";function m(e){n.warn({message:"DCBrowserExt:Messaging:Rejected",...e})}function p(n){return t({...n,resolveModeFn:e,reportRejectionFn:m})}r();export function wrapRuntimeMessageListener(e,n,{mediateFn:t=p,endpoint:r}={}){return o(e,n,{mediateFn:t,endpoint:r,reportRejectionFn:m,startTiming:i,endTiming:s})}export function registerRuntimeMessageHandler(e,n,{endpoint:t,mediateFn:r=p}={}){const i={mediateFn:r,endpoint:t};chrome.runtime.onMessage.addListener(wrapRuntimeMessageListener(e,n,i))}export function registerExternalMessageHandler(e,n,{endpoint:t,wrapListener:r}={}){const i=wrapRuntimeMessageListener(e,n,{mediateFn:p,endpoint:t});chrome.runtime.onMessageExternal.addListener(r?r(i):i)}export function wrapPortMessageListener(e,n,{mediateFn:t=p,endpoint:r}={}){return a(e,n,{mediateFn:t,endpoint:r,reportRejectionFn:m,startTiming:i,endTiming:s})}export function registerPortMessageHandler(e,n,t,{endpoint:r}={}){const i={mediateFn:p,endpoint:r};e.onMessage.addListener(wrapPortMessageListener(n,t,i))}