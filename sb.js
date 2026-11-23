/* Kitchen Circuit: live data through Supabase.
   Gives the scoreboard the same small db interface it used inside Claude
   (doc/collection .set, .delete, .onSnapshot), plus the scorekeeper sign-in. */
(function(){
  var URL="https://yhtlwmkktayzttwrcaqv.supabase.co";
  var KEY="sb_publishable_Hcm_PozoiTG1ZLhwC4F49A_MXdBKgfZ";
  if(!window.supabase||!window.supabase.createClient||window.claude)return;
  var sb=window.supabase.createClient(URL,KEY);
  window.KC_SB=sb;window.KC_SBURL=URL;window.KC_SBKEY=KEY;
  var cache={docs:{},private_docs:{}},loaded={docs:false,private_docs:false},subs=[],wrote={},session=null,editor=null,referee=false;

  function clone(v){return v===undefined?undefined:JSON.parse(JSON.stringify(v));}
  function tbl(p){return p.indexOf("private/")===0?"private_docs":"docs";}
  function docSnap(path){var v=cache[tbl(path)][path];return {id:path.split("/").pop(),exists:v!==undefined,data:function(){return clone(v);}};}
  function colSnap(col){var pre=col+"/",out=[];Object.keys(cache.docs).sort().forEach(function(p){if(p.indexOf(pre)===0&&p.slice(pre.length).indexOf("/")<0)out.push(docSnap(p));});return {docs:out};}
  function emit(s){
    if(!loaded[s.t])return;
    var snap=s.doc?docSnap(s.key):colSnap(s.key),sig=JSON.stringify(s.doc?[snap.exists,snap.data()]:snap.docs.map(function(d){return [d.id,d.data()];}));
    if(sig===s.last)return;s.last=sig;
    try{s.cb(snap);}catch(e){console.error(e);}
  }
  function fire(path,t){subs.forEach(function(s){if(s.t===t&&(s.doc?s.key===path:path.indexOf(s.key+"/")===0))emit(s);});}
  function fireAll(t){subs.forEach(function(s){if(s.t===t)emit(s);});}
  function mapErr(e){
    /* keep scorekeeper mode on and show the database's own reason on the status line */
    var m=(e&&e.message)||String(e);
    return {message:(e&&e.code?e.code+" ":"")+m};
  }
  /* a write refused for lack of permission usually means this device's sign-in lapsed:
     refresh the sign-in and retry once; if there is no sign-in left, say so plainly */
  function signedOut(){
    session=null;editor=false;referee=false;window.KC_ROLE={editor:false,ref:false};footer("Your sign-in on this device has expired. Sign in again to keep entering scores.");
    var st=document.getElementById("st");if(st)st.textContent="Signed out on this device. Sign in again at the bottom of the page.";
  }
  function withRetry(run){
    return run().then(function(r){
      if(!r.error||String(r.error.code)!=="42501")return r;
      return sb.auth.refreshSession().then(function(x){
        if(!(x&&x.data&&x.data.session)){signedOut();return {error:{code:"",message:"signed out on this device. Sign in again at the bottom of the page."}};}
        session=x.data.session;return run();
      });
    });
  }
  function load(t){
    if(t==="private_docs"&&!session){loaded[t]=true;cache[t]={};fireAll(t);return Promise.resolve();}
    var t0=Date.now();
    return sb.from(t).select("path,data").then(function(r){
      if(r.error){subs.forEach(function(s){if(s.t===t&&s.err)s.err(mapErr(r.error));});return;}
      var c={};(r.data||[]).forEach(function(row){c[row.path]=row.data;});
      /* a save made while this read was in flight wins over the older copy the read brought back */
      Object.keys(wrote).forEach(function(p){if(tbl(p)===t&&wrote[p]>=t0-2000){if(cache[t][p]===undefined)delete c[p];else c[p]=cache[t][p];}});
      cache[t]=c;loaded[t]=true;fireAll(t);
    });
  }
  function loadAll(){return Promise.all([load("docs"),load("private_docs")]);}
  function onChange(t){return function(p){
    if(p.eventType==="DELETE"){var o=p.old&&p.old.path;if(o){delete cache[t][o];fire(o,t);}}
    else if(p.new&&p.new.path){cache[t][p.new.path]=p.new.data;fire(p.new.path,t);}
  };}

  /* live connection, with automatic reconnect and a small Live / Reconnecting indicator */
  var CHAN=null,LIVE="",RETRY=null;
  function showLive(){
    var el=document.getElementById("lvst");
    if(!el){var st=document.getElementById("st");if(!st)return;el=document.createElement("span");el.id="lvst";st.parentNode.insertBefore(el,st.nextSibling);}
    var ok=LIVE==="SUBSCRIBED";el.className=ok?"ok":"bad";el.textContent=ok?"\u25CF Live":"Reconnecting\u2026";
  }
  function connect(){
    if(RETRY){clearTimeout(RETRY);RETRY=null;}
    var old=CHAN;CHAN=null;if(old){try{sb.removeChannel(old);}catch(e){}}
    var ch=sb.channel("kc-live-"+Date.now());CHAN=ch;LIVE="";showLive();
    ch.on("postgres_changes",{event:"*",schema:"public",table:"docs"},onChange("docs"))
      .on("postgres_changes",{event:"*",schema:"public",table:"private_docs"},onChange("private_docs"))
      .subscribe(function(st){
        if(ch!==CHAN)return;LIVE=st;showLive();
        if(st==="SUBSCRIBED")loadAll();
        else if(st==="CHANNEL_ERROR"||st==="TIMED_OUT"||st==="CLOSED"){if(!RETRY)RETRY=setTimeout(function(){RETRY=null;connect();},5000);}
      });
  }
  function ref(path){
    var t=tbl(path);
    return {
      set:function(v){var d=clone(v);wrote[path]=Date.now();return withRetry(function(){return sb.from(t).upsert({path:path,data:d,updated_at:new Date().toISOString()});}).then(function(r){if(r.error)throw mapErr(r.error);cache[t][path]=d;wrote[path]=Date.now();fire(path,t);});},
      delete:function(){return withRetry(function(){return sb.from(t).delete().eq("path",path);}).then(function(r){if(r.error)throw mapErr(r.error);delete cache[t][path];wrote[path]=Date.now();fire(path,t);});},
      onSnapshot:function(cb,err){var s={t:t,key:path,doc:true,cb:cb,err:err};subs.push(s);setTimeout(function(){emit(s);},0);return function(){subs.splice(subs.indexOf(s),1);};}
    };
  }
  var db={
    doc:ref,
    collection:function(c){return {
      doc:function(id){return ref(c+"/"+id);},
      onSnapshot:function(cb,err){var s={t:"docs",key:c,doc:false,cb:cb,err:err};subs.push(s);setTimeout(function(){emit(s);},0);return function(){subs.splice(subs.indexOf(s),1);};}
    };}
  };

  var ready=sb.auth.getSession().then(function(r){session=(r&&r.data&&r.data.session)||null;}).catch(function(){session=null;}).then(function(){
    if(!session)return [false,false];
    function chk(fn){return sb.rpc(fn).then(function(r){return !!(r&&r.data===true);}).catch(function(){return false;});}
    return Promise.all([chk("is_editor"),chk("is_ref")]);
  }).then(function(rl){editor=rl[0];referee=rl[1];window.KC_ROLE={editor:editor,ref:referee};footer();
    connect();
    setInterval(function(){if(document.hidden)return;loadAll();if(LIVE!=="SUBSCRIBED")connect();},60000);
    /* phones freeze pages in the background and drop the live connection: on coming back, catch up and reconnect */
    function wake(){if(document.hidden)return;loadAll();if(LIVE!=="SUBSCRIBED")connect();
      if(editor||referee)sb.auth.getSession().then(function(r){if(!(r&&r.data&&r.data.session))signedOut();});}
    document.addEventListener("visibilitychange",wake);
    window.addEventListener("pageshow",wake);window.addEventListener("focus",wake);window.addEventListener("online",function(){connect();loadAll();});
    return loadAll();
  });

  window.claude={use:function(name){
    if(name==="db")return ready.then(function(){return db;});
    if(name==="user")return ready.then(function(){return {canEdit:function(){return editor===true;}};});
    return Promise.resolve(null);
  }};

  /* ---- scorekeeper sign-in, at the bottom of the page ---- */
  function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
  function footer(msg){
    var el=document.getElementById("skl");if(!el)return;
    if(session){
      el.innerHTML='Signed in as '+esc(session.user&&session.user.email||'')+(editor?' (scorekeeper)':referee?' (referee)':' (this email is not on the scorekeeper or referee list)')+' &middot; <a data-sk="out">Sign out</a>';
    }else{
      el.innerHTML='<a data-sk="show">Scorekeeper / referee sign in</a>'+(msg?'<div style="color:#b3261e;margin-top:6px">'+esc(msg)+'</div>':'');
    }
  }
  document.addEventListener("click",function(e){
    var a=e.target&&e.target.dataset&&e.target.dataset.sk;if(!a)return;
    var el=document.getElementById("skl");
    if(a==="show"){el.innerHTML='<form id="skf"><input type="email" id="ske" placeholder="Email" autocomplete="username" required><input type="password" id="skp" placeholder="Password" autocomplete="current-password" required><button type="submit">Sign in</button><a data-sk="cancel">Cancel</a></form>';document.getElementById("ske").focus();}
    else if(a==="cancel")footer();
    else if(a==="out")sb.auth.signOut().then(function(){location.reload();});
  });
  document.addEventListener("submit",function(e){
    if(!e.target||e.target.id!=="skf")return;e.preventDefault();
    var b=e.target.querySelector("button");b.disabled=true;b.textContent="Signing in...";
    sb.auth.signInWithPassword({email:document.getElementById("ske").value.trim(),password:document.getElementById("skp").value}).then(function(r){
      if(r.error){footer("Sign-in failed: "+r.error.message);return;}
      location.reload();
    });
  });
})();
