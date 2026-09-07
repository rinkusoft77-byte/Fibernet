import { CONTACTS, DIAGNOSTICS, POPULAR_SERVICES, URLS } from "./config.js";
import { t } from "./i18n.js";
import {
  addTicketMessage, claimUpdate, cleanupProcessedUpdates, clearState, closeTicket, createTicket,
  getTicket, getTicketBySupportMessage, getUser, listOpenTickets, listUserTickets, parseStateData,
  releaseUpdate, savePhone, setLanguage, setState, setSupportMessageId, ticketStats, upsertUser
} from "./db.js";
import { getSourceStatus, getTariffs, syncOfficialSources } from "./catalog.js";
import { answerCallback, contactKeyboard, editMessage, escapeHtml, inlineKeyboard, removeKeyboard, sendMessage } from "./telegram.js";

const homeKeyboard = lang => inlineKeyboard([
  [{ text:t(lang,"tariffs"),callback_data:"menu:tariffs"},{text:t(lang,"support"),callback_data:"menu:support"}],
  [{ text:t(lang,"connect"),callback_data:"menu:connect"}],
  [{ text:t(lang,"cabinet"),callback_data:"menu:cabinet"},{text:t(lang,"contacts"),callback_data:"menu:contacts"}],
  [{ text:t(lang,"services"),callback_data:"menu:services"},{text:t(lang,"tickets"),callback_data:"menu:tickets"}],
  [{ text:t(lang,"language"),callback_data:"menu:language" }]
]);
const languageKeyboard = () => inlineKeyboard([[{text:"🇺🇿 O‘zbekcha",callback_data:"lang:uz"},{text:"🇷🇺 Русский",callback_data:"lang:ru"}]]);
const back = lang => inlineKeyboard([[{text:t(lang,"back"),callback_data:"menu:home"}]]);
const supportKeyboard = lang => inlineKeyboard([
  [{text:t(lang,"noInternet"),callback_data:"support:no_internet"},{text:t(lang,"slow"),callback_data:"support:slow"}],
  [{text:t(lang,"wifi"),callback_data:"support:wifi"},{text:t(lang,"iptv"),callback_data:"support:iptv"}],
  [{text:t(lang,"billing"),callback_data:"support:billing"},{text:t(lang,"other"),callback_data:"support:other"}],
  [{text:t(lang,"back"),callback_data:"menu:home"}]
]);
const diagKeyboard = (lang,cat) => inlineKeyboard([
  [{text:t(lang,"solved"),callback_data:`diag:${cat}:solved`}],
  [{text:t(lang,"openTicket"),callback_data:`diag:${cat}:ticket`}],
  [{text:t(lang,"back"),callback_data:"menu:support"}]
]);
const supportChat = (env,id) => String(id)===String(env.SUPPORT_CHAT_ID);
const isAdmin = (env,userId,chatId) => supportChat(env,chatId) || String(env.ADMIN_IDS||"").split(",").map(x=>x.trim()).includes(String(userId));
const categoryLabel = (cat,lang) => ({no_internet:lang==="ru"?"Нет интернета":"Internet yo‘q",slow:lang==="ru"?"Низкая скорость":"Internet sekin",wifi:"Wi‑Fi",iptv:"IPTV / TV",billing:lang==="ru"?"Оплата / кабинет":"To‘lov / kabinet",other:lang==="ru"?"Другая проблема":"Boshqa muammo",connection:lang==="ru"?"Подключение":"Ulanish"}[cat]||cat);

async function showHome(env,chatId,lang,messageId){
  const extra={reply_markup:homeKeyboard(lang)};
  return messageId?editMessage(env,chatId,messageId,t(lang,"welcome"),extra):sendMessage(env,chatId,t(lang,"welcome"),extra);
}
async function notifySupport(env,ticketNo){
  if(!env.SUPPORT_CHAT_ID || String(env.SUPPORT_CHAT_ID).startsWith("REPLACE_")) return;
  const ticket=await getTicket(env,ticketNo); if(!ticket) return;
  const user=await getUser(env,ticket.telegram_id);
  const text=[`🎫 <b>FiberNet ticket ${escapeHtml(ticketNo)}</b>`,`Tur: <b>${escapeHtml(categoryLabel(ticket.category,"uz"))}</b>`,`Telegram ID: <code>${ticket.telegram_id}</code>`,user?.username?`Username: @${escapeHtml(user.username)}`:null,`📞 ${escapeHtml(ticket.phone||user?.phone||"—")}`,`📍 ${escapeHtml(ticket.address||"—")}`,`🔐 Login: <code>${escapeHtml(ticket.account_login||"—")}</code>`,``,`📝 ${escapeHtml(ticket.description)}`,``,`Javob berish uchun shu xabarga Reply qiling.`].filter(Boolean).join("\n");
  const m=await sendMessage(env,env.SUPPORT_CHAT_ID,text,{reply_markup:inlineKeyboard([[{text:"✅ Ticketni yopish",callback_data:`admin:close:${ticketNo}`} ]])});
  await setSupportMessageId(env,ticketNo,m.message_id);
}
async function makeTicket(env,user,data,category,description){
  const no=await createTicket(env,{telegramId:user.telegram_id,category,description,accountLogin:data.accountLogin,address:data.address,phone:data.phone||user.phone});
  await clearState(env,user.telegram_id); await notifySupport(env,no); return no;
}
async function stateFlow(env,msg,user){
  if(!user?.state) return false; const lang=user.language||"uz", d=parseStateData(user), chatId=msg.chat.id;
  if(user.state==="ticket_account"){ if(!msg.text)return true; d.accountLogin=msg.text.trim()==="-"?null:msg.text.trim().slice(0,80); await setState(env,user.telegram_id,"ticket_address",d); await sendMessage(env,chatId,t(lang,"askAddress")); return true; }
  if(user.state==="ticket_address"){ if(!msg.text)return true; d.address=msg.text.trim().slice(0,300); await setState(env,user.telegram_id,"ticket_phone",d); await sendMessage(env,chatId,t(lang,"askPhone"),{reply_markup:contactKeyboard(t(lang,"sharePhone"))}); return true; }
  if(user.state==="ticket_phone"){ const phone=msg.contact?.phone_number||(msg.text||"").trim(); if(!phone)return true; d.phone=phone; await savePhone(env,user.telegram_id,phone); await setState(env,user.telegram_id,"ticket_description",d); await sendMessage(env,chatId,t(lang,"askDescription"),{reply_markup:removeKeyboard}); return true; }
  if(user.state==="ticket_description"){ if(!msg.text)return true; const no=await makeTicket(env,user,d,d.category||"other",msg.text.trim().slice(0,2000)); await sendMessage(env,chatId,t(lang,"ticketCreated",{ticket:no}),{reply_markup:homeKeyboard(lang)}); return true; }
  if(user.state==="connect_address"){ if(!msg.text)return true; d.address=msg.text.trim().slice(0,300); await setState(env,user.telegram_id,"connect_phone",d); await sendMessage(env,chatId,t(lang,"connectAskPhone"),{reply_markup:contactKeyboard(t(lang,"sharePhone"))}); return true; }
  if(user.state==="connect_phone"){ const phone=msg.contact?.phone_number||(msg.text||"").trim(); if(!phone)return true; d.phone=phone; await savePhone(env,user.telegram_id,phone); const no=await makeTicket(env,user,d,"connection",lang==="ru"?"Заявка на новое подключение":"Yangi ulanish uchun ariza"); await sendMessage(env,chatId,t(lang,"connectCreated",{ticket:no}),{reply_markup:homeKeyboard(lang)}); return true; }
  return false;
}
async function adminMessage(env,msg){
  const text=(msg.text||"").trim();
  let ticket=null;
  if(msg.reply_to_message?.message_id) ticket=await getTicketBySupportMessage(env,msg.reply_to_message.message_id);
  if(ticket && text && !text.startsWith("/")){ await sendMessage(env,ticket.telegram_id,`👨‍💻 <b>FiberNet operator:</b>\n\n${escapeHtml(text)}`); await addTicketMessage(env,ticket.ticket_no,"operator",msg.from.id,text,msg.message_id); return true; }
  if(text==="/tickets"){ const rows=await listOpenTickets(env,15); await sendMessage(env,msg.chat.id,rows.length?rows.map(x=>`🟡 <b>${x.ticket_no}</b> — ${escapeHtml(categoryLabel(x.category,"uz"))}`).join("\n"):"Ochiq ticketlar yo‘q."); return true; }
  if(text==="/stats"){ const s=await ticketStats(env); await sendMessage(env,msg.chat.id,`📊 Open: <b>${s.open_count||0}</b>\nClosed: <b>${s.closed_count||0}</b>\nTotal: <b>${s.total_count||0}</b>`); return true; }
  if(text==="/sync"){ const r=await syncOfficialSources(env); await sendMessage(env,msg.chat.id,`✅ Sync: <code>${escapeHtml(JSON.stringify(r))}</code>`); return true; }
  if(text.startsWith("/close ")){ const no=text.split(/\s+/)[1]; const ok=await closeTicket(env,no,msg.from.id); if(ok){const x=await getTicket(env,no); if(x)await sendMessage(env,x.telegram_id,`✅ ${no} yopildi / закрыта.`);} await sendMessage(env,msg.chat.id,ok?"✅ Yopildi":"Topilmadi yoki allaqachon yopilgan"); return true; }
  return false;
}
async function callback(env,q){
  await answerCallback(env,q.id); const chatId=q.message.chat.id; let user=await upsertUser(env,q.from); const data=q.data||"";
  if(data.startsWith("lang:")){ const lang=data.slice(5); await setLanguage(env,q.from.id,lang); await clearState(env,q.from.id); return showHome(env,chatId,lang,q.message.message_id); }
  const lang=user.language||"uz";
  if(data==="menu:home") return showHome(env,chatId,lang,q.message.message_id);
  if(data==="menu:language") return editMessage(env,chatId,q.message.message_id,t(lang,"chooseLanguage"),{reply_markup:languageKeyboard()});
  if(data==="menu:support") return editMessage(env,chatId,q.message.message_id,t(lang,"supportChoose"),{reply_markup:supportKeyboard(lang)});
  if(data.startsWith("support:")){ const cat=data.slice(8); return editMessage(env,chatId,q.message.message_id,DIAGNOSTICS[lang]?.[cat]||DIAGNOSTICS.uz.other,{reply_markup:diagKeyboard(lang,cat)}); }
  if(data.startsWith("diag:")){ const [,cat,act]=data.split(":"); if(act==="solved")return showHome(env,chatId,lang,q.message.message_id); if(act==="ticket"){await setState(env,q.from.id,"ticket_account",{category:cat}); return sendMessage(env,chatId,t(lang,"askAccount"));} }
  if(data==="menu:connect"){ await setState(env,q.from.id,"connect_address",{}); return sendMessage(env,chatId,t(lang,"connectAskAddress")); }
  if(data==="menu:cabinet") return editMessage(env,chatId,q.message.message_id,t(lang,"cabinetText"),{reply_markup:inlineKeyboard([[{text:t(lang,"cabinet"),url:URLS.cabinet}],[{text:t(lang,"back"),callback_data:"menu:home"}]])});
  if(data==="menu:contacts"){const addr=lang==="ru"?CONTACTS.addressRu:CONTACTS.addressUz;const body=`${t(lang,"contactsTitle")}\n\n📞 <b>${CONTACTS.phone}</b>\n📧 ${CONTACTS.infoEmail}\n🧑‍💻 ${CONTACTS.supportEmail}\n📍 ${escapeHtml(addr)}`;return editMessage(env,chatId,q.message.message_id,body,{reply_markup:inlineKeyboard([[{text:t(lang,"website"),url:URLS.home}],[{text:t(lang,"back"),callback_data:"menu:home"}]])});}
  if(data==="menu:services"){const body=[t(lang,"servicesTitle"),"",...POPULAR_SERVICES.map(([n,p])=>`• ${escapeHtml(n)} — <b>${p}</b>`)].join("\n");return editMessage(env,chatId,q.message.message_id,body,{reply_markup:back(lang)});}
  if(data==="menu:tariffs") return editMessage(env,chatId,q.message.message_id,t(lang,"tariffChoose"),{reply_markup:inlineKeyboard([[{text:"TEZKOR",callback_data:"tariff:tezkor"},{text:"OnLine",callback_data:"tariff:online"}],[{text:t(lang,"back"),callback_data:"menu:home"}]])});
  if(data.startsWith("tariff:")){const series=data.slice(7),items=await getTariffs(env,series);const lines=items.map(x=>`<b>${escapeHtml(x.name)}</b> — ${Number(x.price||0).toLocaleString("ru-RU")} ${lang==="ru"?"сум/мес":"so‘m/oy"}\n• 18:00–00:00: ${x.evening||"—"} Mbit/s\n• 00:00–18:00: ${x.daytime||"—"} Mbit/s`).join("\n\n");return editMessage(env,chatId,q.message.message_id,`📶 <b>${series.toUpperCase()}</b>\n\n${lines}\n\n${t(lang,"officialSource")}`,{reply_markup:back(lang)});}
  if(data==="menu:tickets"){const rows=await listUserTickets(env,q.from.id,8);const body=rows.length?rows.map(x=>`${x.status==="open"?"🟡":"✅"} <b>${x.ticket_no}</b> — ${escapeHtml(categoryLabel(x.category,lang))}`).join("\n"):t(lang,"emptyTickets");return editMessage(env,chatId,q.message.message_id,`🎫 <b>${t(lang,"tickets")}</b>\n\n${body}`,{reply_markup:back(lang)});}
  if(data.startsWith("admin:close:")&&isAdmin(env,q.from.id,chatId)){const no=data.slice(12);const ok=await closeTicket(env,no,q.from.id);if(ok){const x=await getTicket(env,no);if(x)await sendMessage(env,x.telegram_id,`✅ ${no} yopildi / закрыта.`);}return answerCallback(env,q.id,ok?"Yopildi":"Topilmadi");}
}
async function message(env,msg){
  if(!msg.from||msg.from.is_bot)return; const chatId=msg.chat.id;
  if(isAdmin(env,msg.from.id,chatId)&&supportChat(env,chatId) && await adminMessage(env,msg)) return;
  if(msg.chat.type!=="private")return; let user=await upsertUser(env,msg.from); const text=(msg.text||"").trim();
  if(text==="/start"){await clearState(env,msg.from.id);if(!user.language)return sendMessage(env,chatId,t("uz","chooseLanguage"),{reply_markup:languageKeyboard()});return showHome(env,chatId,user.language);}
  if(text==="/language")return sendMessage(env,chatId,t(user.language||"uz","chooseLanguage"),{reply_markup:languageKeyboard()});
  if(text==="/cancel"){await clearState(env,msg.from.id);return showHome(env,chatId,user.language||"uz");}
  user=await getUser(env,msg.from.id); if(await stateFlow(env,msg,user))return; await sendMessage(env,chatId,t(user.language||"uz","unknown"),{reply_markup:homeKeyboard(user.language||"uz")});
}
async function webhook(request,env){
  if(!env.TELEGRAM_WEBHOOK_SECRET||request.headers.get("X-Telegram-Bot-Api-Secret-Token")!==env.TELEGRAM_WEBHOOK_SECRET)return new Response("Unauthorized",{status:401});
  let u;try{u=await request.json();}catch{return new Response("Bad Request",{status:400});} if(!Number.isInteger(u.update_id))return new Response("ok");
  if(!await claimUpdate(env,u.update_id))return new Response("ok");try{if(u.callback_query)await callback(env,u.callback_query);else if(u.message)await message(env,u.message);return new Response("ok");}catch(e){console.error(e);await releaseUpdate(env,u.update_id);return new Response("Retry",{status:500});}
}
export default {
  async fetch(request,env){const url=new URL(request.url);if(request.method==="POST"&&url.pathname==="/telegram/webhook")return webhook(request,env);if(request.method==="GET"&&url.pathname==="/health"){try{const s=await getSourceStatus(env);return Response.json({ok:true,service:"fibernet-support-bot",sources:s});}catch(e){return Response.json({ok:false,error:String(e)},{status:503});}}if(request.method==="POST"&&url.pathname==="/admin/sync"){const a=request.headers.get("authorization")||"";if(!env.ADMIN_API_TOKEN||a!==`Bearer ${env.ADMIN_API_TOKEN}`)return new Response("Unauthorized",{status:401});return Response.json({ok:true,report:await syncOfficialSources(env)});}if(url.pathname==="/")return new Response("FiberNet Support Bot is running.");return new Response("Not found",{status:404});},
  async scheduled(_c,env,ctx){ctx.waitUntil((async()=>{await syncOfficialSources(env);await cleanupProcessedUpdates(env);})());}
};
