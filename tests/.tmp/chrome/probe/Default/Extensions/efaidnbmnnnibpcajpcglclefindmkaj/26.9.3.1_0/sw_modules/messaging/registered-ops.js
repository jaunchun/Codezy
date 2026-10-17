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
import{register as e}from"./message-registry.js";import{OP as r}from"./op-ids.js";import{BUS as t,SENDER_TIER as E}from"./messaging-constants.js";e({op:r.KW_PERF_MARK,bus:t.RUNTIME_MESSAGE,allowedSenderTiers:[E.CONTENT_SCRIPT,E.EXTENSION_PAGE_EMBEDDED_IN_FOREIGN_TAB],schema:{data:{required:!0,type:"object",schema:{requestId:{required:!0,type:"string"},name:{required:!0,type:"string"},metadata:{required:!1,type:"object"},timestamp:{required:!1,type:"number"}}}},targetEndpoint:"add-webpage-to-project"}),e({op:r.CLOSE_ALL_IFRAMES,bus:t.POST_MESSAGE,allowedSenderTiers:[E.CDN_POSTMESSAGE],schema:{},targetEndpoint:"add-webpage-to-project"}),e({op:r.RESET_DIRECT_VERB_CTA,bus:t.RUNTIME_MESSAGE,allowedSenderTiers:[E.SERVICE_WORKER],schema:{},targetEndpoint:["google-docs-content-script","wikipedia-content-script"]}),e({op:r.UPDATE_DIRECT_VERB_PROGRESS,bus:t.RUNTIME_MESSAGE,allowedSenderTiers:[E.SERVICE_WORKER],schema:{progress:{required:!0,type:"number"},directVerbSessionId:{required:!0,type:"string"}},targetEndpoint:["google-docs-content-script","wikipedia-content-script"]}),e({op:r.DETECT_EXTENSION,bus:t.EXTERNAL_MESSAGE,allowedSenderTiers:[E.CONTENT_SCRIPT],schema:{type:{required:!0,type:"string"}},targetEndpoint:"externalClients"}),e({op:r.KEEP_ALIVE,bus:t.RUNTIME_CONNECT,allowedSenderTiers:[E.EXTENSION_PAGE_OPENED_DIRECTLY],schema:{},targetEndpoint:"sidepanel-port"}),e({op:r.CREATE_IFRAME_TO_LOAD_AJS_WORKER,bus:t.RUNTIME_MESSAGE,allowedSenderTiers:[E.SERVICE_WORKER],schema:{target:{required:!0,type:"string"},rrvEnabled:{required:!0,type:"boolean"},env:{required:!0,type:"string"},anonUserUUID:{required:!0,type:"string"}},targetEndpoint:"offscreen"});