// ---------- data model ----------
// Society holds its own security helpdesk + template. A listing belongs to one society.
const societies = {
  S1:{name:"Greenwood Society, Candolim", to:"security@greenwoodsociety.in", cc:"clubhouse@greenwoodsociety.in",
      template:`Dear Security Team,\n\nPlease find attached the ID proofs for guests arriving at {{listing}}.\n\nBooking reference: {{booking_id}}\nCheck-in: {{check_in}}\nCheck-out: {{check_out}}\nAdult guests: {{adult_count}}\n\nKindly allow entry as per society guidelines.\n\nRegards,\nArjun K. (Host)`},
  S2:{name:"Hillcrest Residency, Coorg", to:"gate@hillcrestcoorg.in", cc:"manager@hillcrestcoorg.in",
      template:`Hello Gate Desk,\n\nGuest ID documents for the stay at {{listing}} are attached.\n\nRef {{booking_id}} · {{adult_count}} adult(s)\nArriving {{check_in}}, leaving {{check_out}}.\n\nThank you,\nArjun`}
};
const listings = {
  L1:{name:"Sea Breeze 2BHK, Candolim", society:"S1"},
  L2:{name:"Hillview Studio, Coorg",    society:"S2"}
};

let bookings = [
  { id:"HMABCD1234", listing:"L1", guest:"Priya Menon", ci:"2026-09-20", nights:3, co:"2026-09-23",
    adults:3, children:1, sent:false, conflict:false, auto:"allids",
    people:[{name:"Priya Menon",lead:true,doc:"Aadhaar",up:true},{name:"Rohit Menon",lead:false,doc:null,up:false},{name:"Adult guest 3",lead:false,doc:null,up:false}],
    log:[{t:"18 Sep 10:04",x:"Booking synced from Airbnb"},{t:"18 Sep 10:22",x:"Priya uploaded Aadhaar"}] },
  { id:"HMEFGH5678", listing:"L2", guest:"Daniel Fernandes", ci:"2026-09-21", nights:2, co:"2026-09-23",
    adults:2, children:0, sent:false, conflict:false, auto:"before",
    people:[{name:"Daniel Fernandes",lead:true,doc:"Passport",up:true},{name:"Aisha Fernandes",lead:false,doc:"Aadhaar",up:true}],
    log:[{t:"17 Sep 19:40",x:"Booking synced from Airbnb"},{t:"18 Sep 08:11",x:"Both IDs uploaded"}] },
  { id:"HMIJKL9012", listing:"L1", guest:"Sana Kapoor", ci:"2026-09-25", nights:4, co:"2026-09-29",
    adults:2, children:2, sent:true, conflict:false, auto:"allids",
    people:[{name:"Sana Kapoor",lead:true,doc:"Aadhaar",up:true},{name:"Vikram Kapoor",lead:false,doc:"Driving licence",up:true}],
    log:[{t:"15 Sep 12:00",x:"Booking synced from Airbnb"},{t:"16 Sep 09:30",x:"Both IDs uploaded"},{t:"16 Sep 09:31",x:"Email sent to security helpdesk"}] },
  { id:"HMMNOP3456", listing:"L2", guest:"Meera Nair", ci:"2026-10-02", nights:1, co:"2026-10-03",
    adults:1, children:0, sent:false, conflict:true, auto:"before",
    people:[{name:"Meera Nair",lead:true,doc:null,up:false}],
    log:[{t:"18 Sep 07:15",x:"Sync conflict: dates overlap an existing block"}] },
];

// ---------- helpers ----------
const MONTHS=["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
function fmtCal(d){const dt=new Date(d);return{mo:MONTHS[dt.getMonth()],dy:dt.getDate()};}
function fmtLong(d){const dt=new Date(d);const days=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];return `${days[dt.getDay()]} ${dt.getDate()} ${MONTHS[dt.getMonth()][0]+MONTHS[dt.getMonth()].slice(1).toLowerCase()}`;}
function initials(n){return n.split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase();}
function soc(b){return societies[listings[b.listing].society];}
function uploaded(b){return b.people.filter(p=>p.up).length;}
function total(b){return b.people.length;}
function statusOf(b){if(b.conflict)return"conflict";if(b.sent)return"sent";if(uploaded(b)===total(b))return"ready";return"awaiting";}
const STATUS={awaiting:{cls:"awaiting",txt:"Awaiting IDs"},ready:{cls:"ready",txt:"Ready to send"},sent:{cls:"sent",txt:"Sent"},conflict:{cls:"conflict",txt:"Sync conflict"}};
function pill(s){const m=STATUS[s];return `<span class="pill ${m.cls}"><span class="dot"></span>${m.txt}</span>`;}
function esc(s){return s.replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));}
function fillTemplate(b){return soc(b).template
  .replace(/{{listing}}/g,listings[b.listing].name).replace(/{{booking_id}}/g,b.id)
  .replace(/{{check_in}}/g,fmtLong(b.ci)).replace(/{{check_out}}/g,fmtLong(b.co))
  .replace(/{{adult_count}}/g,b.adults).replace(/{{guest_name}}/g,b.guest);}

// ---------- state ----------
let view={screen:"bookings",bookingId:null,filter:"all",tab:"listings",openSoc:null};
const main=document.getElementById("main");

function render(){
  document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active",b.dataset.nav===(view.screen==="detail"?"bookings":view.screen)));
  if(view.screen==="bookings")renderList();
  else if(view.screen==="detail")renderDetail();
  else renderSettings();
  window.scrollTo(0,0);
}

// ---------- list ----------
function renderList(){
  const now=Date.now();
  let list=bookings.filter(b=>(view.filter==="all"||b.listing===view.filter)&&(new Date(b.co).getTime()+24*3600*1000)>=now).sort((a,b)=>new Date(a.ci)-new Date(b.ci));
  const attn=list.filter(b=>["awaiting","conflict"].includes(statusOf(b)));
  const done=list.filter(b=>["ready","sent"].includes(statusOf(b)));
  const opts=`<option value="all">All listings</option>`+Object.entries(listings).map(([k,v])=>`<option value="${k}" ${view.filter===k?"selected":""}>${v.name}</option>`).join("");
  main.innerHTML=`
    <div class="page-head">
      <div><h1>Bookings</h1><div class="sub">${attn.length} need your attention · ${done.length} ready or sent</div></div>
      <select class="filter" id="flt">${opts}</select>
    </div>
    <div class="syncline">
      <span class="live"><span class="d"></span>Auto-syncing from Airbnb</span>
      <span class="sep">·</span><span>New bookings and IDs appear on their own; past bookings drop off 24h after checkout</span>
      <span class="sep">·</span><button id="syncnow">Sync now</button>
    </div>
    ${attn.length?`<div class="group-label">Needs your attention</div>`+attn.map(cardHTML).join(""):`<div class="group-label">Needs your attention</div><div class="card"><div class="empty">Nothing waiting. Every upcoming booking has its IDs in.</div></div>`}
    ${done.length?`<div class="group-label">Ready &amp; sent</div>`+done.map(cardHTML).join(""):""}`;
  document.getElementById("flt").onchange=e=>{view.filter=e.target.value;render();};
  document.getElementById("syncnow").onclick=()=>toast("Checked Airbnb — no new bookings");
  document.querySelectorAll("[data-open]").forEach(el=>el.onclick=()=>{view.bookingId=el.dataset.open;view.screen="detail";render();});
}
function cardHTML(b){
  const c=fmtCal(b.ci),s=statusOf(b);
  const right=s==="conflict"?pill(s):`${pill(s)}<span class="idcount"><b>${uploaded(b)}</b> of ${total(b)} adult IDs</span>`;
  return `<button class="bk" data-open="${b.id}">
    <div class="cal"><span class="mo">${c.mo}</span><span class="dy">${c.dy}</span></div>
    <div class="body">
      <div class="top"><span class="guest">${b.guest}</span><span class="listing">· ${listings[b.listing].name}</span></div>
      <div class="meta"><span>Check-in <b>${fmtLong(b.ci)}</b> · ${b.nights} night${b.nights>1?"s":""}</span><span>${b.adults} adult${b.adults>1?"s":""}${b.children?` · ${b.children} child${b.children>1?"ren":""}`:""}</span></div>
    </div>
    <div class="right">${right}</div>
    <svg class="chev" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
  </button>`;
}

// ---------- detail ----------
function renderDetail(){
  const b=bookings.find(x=>x.id===view.bookingId),s=statusOf(b),allIn=uploaded(b)===total(b),society=soc(b);
  main.innerHTML=`
    <button class="back" id="back"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>Bookings</button>
    <div class="d-head">
      <div><h1>${b.guest}</h1>
        <div class="stay">${listings[b.listing].name} · Check-in <b>${fmtLong(b.ci)}</b> → Check-out <b>${fmtLong(b.co)}</b> · ${b.adults} adult${b.adults>1?"s":""}${b.children?`, ${b.children} child${b.children>1?"ren":""}`:""}</div>
        <div class="bkid">Airbnb booking ${b.id}</div></div>
      ${pill(s)}
    </div>
    ${b.conflict?`<div class="mail" style="border-color:var(--red);background:var(--red-soft)"><div class="mbody" style="color:var(--red)"><b>Sync conflict.</b> This booking's dates overlap an existing block on ${listings[b.listing].name}. Fix it on Airbnb and it will sync cleanly. ID collection is paused until then.</div></div>`:`

    <div class="destcard">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M6 21V7l6-4 6 4v14"/><path d="M9 9h.01M9 13h.01M9 17h.01M15 9h.01M15 13h.01M15 17h.01"/></svg>
      <div><b>IDs go to ${society.name}</b><div class="d2">${society.to}${society.cc?` · cc ${society.cc}`:""}</div></div>
    </div>

    <div class="share">
      <button class="btn" id="copybk"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>Copy guest upload link</button>
      <button class="btn ghost" id="previewg">Preview guest page</button>
      <span style="align-self:center;color:var(--muted);font-size:12.5px">Share this with the guest — it opens only this booking, nothing else.</span>
    </div>

    <div class="section">
      <div class="sechead"><h2>Guest IDs</h2></div>
      <p class="note">One ID proof per adult. Upload for them, or let the guest upload from the link above.</p>
      ${b.people.map((p,i)=>idRow(b,p,i)).join("")}
    </div>

    <div class="section">
      <div class="sechead"><h2>Email to security</h2></div>
      <p class="note">Uses ${society.name}'s saved template and desk. Change it in Settings → Societies.</p>
      <div class="mail">
        <div class="mrow"><span class="k">To</span><span class="v">${society.to}</span></div>
        <div class="mrow"><span class="k">Cc</span><span class="v">${society.cc||"—"}</span></div>
        <div class="mbody">${esc(fillTemplate(b))}</div>
        <div class="attn">${b.people.filter(p=>p.up).map(p=>`<span class="chip"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>${p.name.split(" ")[0]}_${(p.doc||"ID").replace(/ /g,"")}.pdf</span>`).join("")||`<span class="idcount">No files attached yet.</span>`}</div>
      </div>
      <div class="auto">
        ${radio(b,"before","Auto-send 1 hour before check-in","Sends on schedule even if some IDs are still missing.")}
        ${radio(b,"allids","Auto-send when all IDs are collected","Fires the moment the last adult ID is uploaded — good for gate arrivals.")}
      </div>
      <div class="sendbar">
        <button class="btn primary lg" id="send" ${allIn?"":"disabled"}><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>${b.sent?"Resend now":"Send now"}</button>
        <span class="hint">${allIn?(b.sent?"Already sent — you can resend if needed.":"All IDs are in. You can send now."):`Waiting on ${total(b)-uploaded(b)} ID${total(b)-uploaded(b)>1?"s":""}. Auto-send will fire on its own.`}</span>
      </div>
    </div>

    <div class="section"><div class="sechead"><h2>Activity</h2></div>
      <ul class="log">${b.log.map(l=>`<li><span class="bud"></span><span class="t">${l.t}</span><span>${l.x.replace(/^([^:]+:)/,'<b>$1</b>')}</span></li>`).join("")}</ul>
    </div>`}
  `;
  document.getElementById("back").onclick=()=>{view.screen="bookings";render();};
  if(!b.conflict){
    document.getElementById("copybk").onclick=()=>toast("Guest upload link copied");
    const pv=document.getElementById("previewg");if(pv)pv.onclick=()=>openGuest(b.id);
    document.querySelectorAll("[data-up]").forEach(el=>el.onclick=()=>doUpload(b,+el.dataset.up));
    document.querySelectorAll("[data-preview]").forEach(el=>el.onclick=()=>{const p=b.people[+el.dataset.preview];toast(`Opening ${p.name.split(" ")[0]}'s ${p.doc}`);});
    document.querySelectorAll("[data-auto]").forEach(el=>el.onclick=()=>{b.auto=el.dataset.auto;render();});
    const send=document.getElementById("send");if(send)send.onclick=()=>doSend(b);
  }
}
function idRow(b,p,i){
  return `<div class="idrow">
    <div class="av">${initials(p.name)}</div>
    <div class="info"><div class="nm">${p.name}${p.lead?'<span class="tag">LEAD GUEST</span>':''}</div><div class="st ${p.up?'done':''}">${p.up?`${p.doc} uploaded`:"No ID uploaded yet"}</div></div>
    <div class="acts">${p.up
      ?`<button class="btn" data-preview="${i}"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>View</button>`
      :`<button class="btn primary" data-up="${i}"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>Upload ID</button>`}</div>
  </div>`;
}
function radio(b,val,title,desc){return `<div class="radio ${b.auto===val?'on':''}" data-auto="${val}" role="radio" tabindex="0" aria-checked="${b.auto===val}"><div class="ring"></div><div><div class="rt">${title}</div><div class="rd">${desc}</div></div></div>`;}

// ---------- actions ----------
function nowStamp(){const d=new Date();return `${d.getDate()} ${MONTHS[d.getMonth()][0]+MONTHS[d.getMonth()].slice(1).toLowerCase()} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;}
function doUpload(b,i){const p=b.people[i];p.up=true;if(!p.doc)p.doc="Aadhaar";b.log.unshift({t:nowStamp(),x:`${p.name.split(" ")[0]} ID uploaded`});toast("ID uploaded");
  if(uploaded(b)===total(b)&&b.auto==="allids"&&!b.sent){setTimeout(()=>doSend(b,true),400);}render();}
function doSend(b,auto){b.sent=true;b.log.unshift({t:nowStamp(),x:`Email ${auto?"auto-":""}sent to security helpdesk`});toast(auto?"All IDs in — auto-sent to security":"Sent to security helpdesk");render();}

// ---------- guest preview ----------
function guestPreview(b){
  const bd=document.getElementById("backdrop"),md=document.getElementById("modal");
  md.innerHTML=`
    <div class="mh"><span class="lbl">What the guest sees from the link</span><button class="x" id="mx">×</button></div>
    <div class="mc">
      <h3>Upload your ID</h3>
      <div class="gsub">${b.guest} · ${listings[b.listing].name}</div>
      <div class="banner">Only your own booking is shown here. IDs go straight to the society's security desk.</div>
      <div class="stepper"><div><div class="lab">Adults in your party</div></div>
        <div class="ct"><button>−</button><span class="n">${b.adults}</span><button>+</button></div></div>
      ${b.people.map(p=>`<div class="idrow" style="margin-bottom:8px"><div class="av">${initials(p.name)}</div>
        <div class="info"><div class="nm">${p.name}</div><div class="st ${p.up?'done':''}">${p.up?`${p.doc} uploaded`:"Tap to add ID"}</div></div>
        ${p.up?'<svg viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M20 6L9 17l-5-5"/></svg>':'<button class="btn primary sm">Add</button>'}</div>`).join("")}
    </div>`;
  bd.classList.add("show");
  document.getElementById("mx").onclick=()=>bd.classList.remove("show");
  bd.onclick=e=>{if(e.target===bd)bd.classList.remove("show");};
}

// ---------- settings ----------
function renderSettings(){
  main.innerHTML=`
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Set these once. Bookings reuse them automatically.</div></div></div>
    <div class="tabs">${["listings","societies","access"].map(t=>`<button class="tab ${view.tab===t?'active':''}" data-tab="${t}">${({listings:"Listings",societies:"Societies & templates",access:"Admin access"})[t]}</button>`).join("")}</div>
    <div id="sbody"></div>`;
  document.querySelectorAll("[data-tab]").forEach(el=>el.onclick=()=>{view.tab=el.dataset.tab;render();});
  const body=document.getElementById("sbody");
  if(view.tab==="listings")renderSetListings(body);else if(view.tab==="societies")renderSetSocieties(body);else renderSetAccess(body);
}
function renderSetListings(body){
  const socOpts=Object.entries(societies).map(([k,v])=>`<option value="${k}">${v.name}</option>`).join("");
  body.innerHTML=`
    <p class="setnote">Connect each listing once with its Airbnb calendar link (Airbnb → your listing → Availability → Connect calendars → Export). After that, bookings sync on their own.</p>
    ${Object.entries(listings).map(([k,v])=>`<div class="listing-row">
      <div style="flex:1"><div class="nm">${v.name}</div><div class="url">https://www.airbnb.co.in/calendar/ical/${k}xxxx.ics</div><span class="socbadge">${societies[v.society].name}</span></div>
      <span class="syncdot"><span class="d"></span>Synced</span></div>`).join("")}
    <div class="listing-row" style="flex-direction:column;align-items:stretch;gap:10px">
      <div class="nm">Connect a new listing</div>
      <div style="color:var(--muted);font-size:12.5px">Paste the calendar link first. The name fills from the calendar where possible — edit it if needed. You pick the society yourself, so it is never guessed.</div>
      <input class="input" placeholder="Paste Airbnb calendar link (.ics)">
      <input class="input" placeholder="Listing name (from the calendar — editable)">
      <select class="input" aria-label="Society">${socOpts}<option value="new">＋ New society…</option></select>
      <button class="btn primary" id="addListing" style="align-self:flex-start">Connect listing</button>
    </div>`;
  document.getElementById("addListing").onclick=()=>toast("Listing connected — it will start syncing");
}
function renderSetSocieties(body){
  body.innerHTML=`
    <p class="setnote">Each society keeps its own security desk email and its own template. Listings in the same society share one; different societies each use their own.</p>
    ${Object.entries(societies).map(([k,v])=>socCard(k,v)).join("")}
    <button class="btn" id="addSoc" style="margin-top:6px"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>Add a society</button>`;
  document.querySelectorAll("[data-sochead]").forEach(el=>el.onclick=()=>{const k=el.dataset.sochead;view.openSoc=view.openSoc===k?null:k;render();});
  document.querySelectorAll("[data-savesoc]").forEach(el=>el.onclick=()=>{
    const k=el.dataset.savesoc;
    societies[k].to=document.getElementById("to_"+k).value;
    societies[k].cc=document.getElementById("cc_"+k).value;
    societies[k].template=document.getElementById("tpl_"+k).value;
    toast(societies[k].name.split(",")[0]+" saved");
  });
  const add=document.getElementById("addSoc");if(add)add.onclick=()=>toast("Name the society, add its desk email and template");
}
function socCard(k,v){
  const open=view.openSoc===k;const count=Object.values(listings).filter(l=>l.society===k).length;
  return `<div class="soc ${open?'open':''}">
    <div class="sh" data-sochead="${k}"><div><div class="snm">${v.name}</div><div class="smeta">${v.to} · ${count} listing${count!==1?"s":""}</div></div>
      <svg class="caret" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></div>
    <div class="sbody">
      <div class="field"><label>Send to</label><div class="desc">The society's security / gate desk.</div><input class="input" id="to_${k}" value="${v.to}"></div>
      <div class="field"><label>Cc</label><div class="desc">Manager, clubhouse, etc. Comma-separated.</div><input class="input" id="cc_${k}" value="${v.cc||""}"></div>
      <div class="field"><label>Email template</label>
        <div class="desc">Placeholders fill per booking: <span class="var">{{listing}}</span><span class="var">{{guest_name}}</span><span class="var">{{booking_id}}</span><span class="var">{{check_in}}</span><span class="var">{{check_out}}</span><span class="var">{{adult_count}}</span></div>
        <textarea class="input" id="tpl_${k}">${esc(v.template)}</textarea></div>
      <button class="btn primary" data-savesoc="${k}">Save society</button>
    </div></div>`;
}

function renderSetAccess(body){
  body.innerHTML=`
    <p class="setnote">One 4-digit passcode unlocks the admin side for everyone on your team. It starts at 0000, so you're never locked out. Any admin can see it here and change it.</p>
    <div class="field"><label>Current passcode</label>
      <div class="desc">Share this only with people you trust as admins.</div>
      <div style="font-family:ui-monospace,monospace;font-size:26px;font-weight:700;letter-spacing:10px;background:var(--surface-2);border:1px solid var(--line);border-radius:11px;padding:12px 20px;display:inline-block">${adminPasscode}</div>
    </div>
    <div class="field"><label>Change passcode</label>
      <div class="desc">Enter a new 4-digit code. It takes effect right away.</div>
      <input class="input" id="newpin" inputmode="numeric" maxlength="4" placeholder="e.g. 2580" style="max-width:190px;letter-spacing:8px;font-size:19px;font-weight:700">
    </div>
    <button class="btn primary" id="savepin">Update passcode</button>`;
  const inp=document.getElementById("newpin");
  inp.oninput=()=>{inp.value=inp.value.replace(/\D/g,"").slice(0,4);};
  document.getElementById("savepin").onclick=()=>{
    if(inp.value.length!==4){toast("Enter 4 digits");return;}
    adminPasscode=inp.value;toast("Passcode updated");render();
  };
}

// ---------- toast ----------
let toastTimer;
function toast(msg){const t=document.getElementById("toast");t.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>${msg}`;t.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove("show"),2200);}

// ---------- admin lock ----------
const ADMIN_PASSCODE_DEFAULT="0000";
let adminPasscode=ADMIN_PASSCODE_DEFAULT;
let unlocked=false;

function showLock(err){
  clearOverlays();
  const el=document.createElement("div");el.className="lock";el.id="lockScreen";
  el.innerHTML=`<div class="lockcard">
    <div class="mk"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg></div>
    <h2>GatePass</h2><p>Enter the admin passcode to continue.</p>
    <div class="pin ${err?'err':''}" id="pin">
      ${[0,1,2,3].map(i=>`<input inputmode="numeric" maxlength="1" data-i="${i}" aria-label="Digit ${i+1}">`).join("")}
    </div>
    <div class="lockerr">${err?"Wrong passcode. Try again.":""}</div>
    <div class="lockhint">Starts at 0000 · current demo code: ${adminPasscode}</div>
  </div>`;
  document.body.appendChild(el);
  const inputs=[...el.querySelectorAll(".pin input")];
  inputs[0].focus();
  inputs.forEach((inp,i)=>{
    inp.oninput=()=>{inp.value=inp.value.replace(/\D/g,"");if(inp.value&&i<3)inputs[i+1].focus();
      if(inputs.every(x=>x.value)){const code=inputs.map(x=>x.value).join("");
        if(code===adminPasscode){unlocked=true;el.remove();mountApp();}
        else{el.remove();showLock(true);}}};
    inp.onkeydown=e=>{if(e.key==="Backspace"&&!inp.value&&i>0)inputs[i-1].focus();};
  });
}

// ---------- guest page (mobile) ----------
function openGuest(id){try{location.hash="u/"+id;}catch(e){}showGuest(id);}
function clearOverlays(){["lockScreen","guestScreen"].forEach(id=>{const n=document.getElementById(id);if(n)n.remove();});}

function guestLinkActive(b){return Date.now()<=new Date(b.co).getTime()+24*3600*1000;}
function showGuest(id){
  clearOverlays();
  const b=bookings.find(x=>x.id===id);
  const el=document.createElement("div");el.className="gpage";el.id="guestScreen";
  const brand=`<div class="gbrand"><div class="mk"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h18M7 3v4M17 3v4"/><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M9 15l2 2 4-4"/></svg></div><div class="nm">GatePass check-in</div></div>`;
  if(!b||!guestLinkActive(b)){
    el.innerHTML=`<div class="gcard gexpired">${brand}<h2>Link not active</h2><p style="color:var(--muted);font-size:13.5px">This upload link has expired or isn't valid. Guest links stay open until 24 hours after checkout. Please ask your host for a fresh link.</p></div>`;
    document.body.appendChild(el);return;
  }
  const allIn=uploaded(b)===total(b);
  el.innerHTML=`<div class="gcard">
    ${brand}
    <h2>Upload your ID</h2>
    <div class="gsub">${b.guest} · ${listings[b.listing].name}</div>
    <div class="gdates">Check-in ${fmtLong(b.ci)} → Check-out ${fmtLong(b.co)}</div>
    <div class="banner">Only your booking is shown here. Your IDs go straight to the society's security desk — you don't need an account, and nothing else is sent to you.</div>
    <div class="stepper"><div class="lab">Adults in your party</div>
      <div class="ct"><button data-adj="-1">−</button><span class="n">${b.people.length}</span><button data-adj="1">+</button></div></div>
    <div style="color:var(--faint);font-size:12px;margin:-4px 0 14px">Add a row for every adult, including friends or visitors joining you — each needs their own ID.</div>
    ${b.people.map((p,i)=>`<div class="grow"><div class="av">${initials(p.name)}</div>
      <div class="gi"><div class="gn">${p.name}${p.lead?" (you)":""}</div><div class="gs ${p.up?'done':''}">${p.up?`${p.doc} uploaded`:"Aadhaar, passport or any govt ID"}</div></div>
      ${p.up?'<svg viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="22" height="22"><path d="M20 6L9 17l-5-5"/></svg>':`<button class="btn primary" data-gup="${i}">Add ID</button>`}
    </div>`).join("")}
    ${allIn?`<div class="gdone"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>All set — your host has your IDs. You can close this page.</div>`:""}
    ${unlocked?`<button class="gback" id="gback">← Preview mode · back to admin</button>`:""}
  </div>`;
  document.body.appendChild(el);
  el.querySelectorAll("[data-gup]").forEach(x=>x.onclick=()=>{const p=b.people[+x.dataset.gup];p.up=true;if(!p.doc)p.doc="Aadhaar";b.log.unshift({t:nowStamp(),x:`${p.name.split(" ")[0]} uploaded ID (guest)`});
    if(uploaded(b)===total(b)&&b.auto==="allids"&&!b.sent){b.sent=true;b.log.unshift({t:nowStamp(),x:"Email auto-sent to security helpdesk"});}
    showGuest(id);});
  el.querySelectorAll("[data-adj]").forEach(x=>x.onclick=()=>{guestAdjust(b,+x.dataset.adj);showGuest(id);});
  const gb=el.querySelector("#gback");if(gb)gb.onclick=()=>{try{location.hash="";}catch(e){}clearOverlays();unlocked?mountApp():showLock();};
}
function guestAdjust(b,delta){
  if(delta>0){b.people.push({name:`Adult ${b.people.length+1}`,lead:false,doc:null,up:false});b.adults=b.people.length;}
  else{if(b.people.length<=1)return;const last=b.people[b.people.length-1];if(last.up||last.lead)return;b.people.pop();b.adults=b.people.length;}
}

// ---------- boot ----------
function mountApp(){
  clearOverlays();
  document.querySelectorAll(".nav-btn").forEach(b=>b.onclick=()=>{view.screen=b.dataset.nav;render();});
  render();
}
function boot(){
  const h=(location.hash||"").replace("#","");
  if(h.startsWith("u/")){showGuest(h.slice(2));return;}
  unlocked?mountApp():showLock();
}
window.addEventListener("hashchange",()=>{const h=(location.hash||"").replace("#","");if(h.startsWith("u/"))showGuest(h.slice(2));});
boot();
