export type AnalyticsEvent =
  | {type:'user_connected', ts:number, userId:string, sessionId:string, platform:string, region?:string}
  | {type:'user_disconnected', ts:number, userId:string, sessionId:string, duration_ms:number}
  | {type:'room_joined', ts:number, userId:string, roomId:string, members:number}
  | {type:'room_left', ts:number, userId:string, roomId:string, members:number}
  | {type:'message_sent', ts:number, userId:string, roomId:string, kind:'text'|'image'|'gif'|'sticker'|'audio', bytes_in:number, recipients:number, server_proc_ms:number}
  | {type:'message_delivered', ts:number, roomId:string, delivered_to:number, bytes_out:number}
  | {type:'media_uploaded', ts:number, userId:string, roomId?:string, mime:string, bytes_in:number}
  | {type:'media_downloaded', ts:number, userId?:string, roomId?:string, mime:string, bytes_out:number}
  | {type:'throttle_hit', ts:number, userId?:string, sessionId?:string, rule_id:string}
  | {type:'error_occurred', ts:number, op:string, code:string};


