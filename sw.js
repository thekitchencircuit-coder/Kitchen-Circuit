/* Kitchen Circuit service worker: lets the site install to the home screen and show match-call notifications.
   It does not cache anything, so players always get the latest scoreboard. */
self.addEventListener("install", function(){ self.skipWaiting(); });
self.addEventListener("activate", function(e){ e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function(){ /* network only */ });
self.addEventListener("push", function(e){
  var d={};
  try{ d=e.data?e.data.json():{}; }catch(x){ d={body:e.data?e.data.text():""}; }
  e.waitUntil(self.registration.showNotification(d.title||"Kitchen Circuit",{
    body:d.body||"", tag:d.tag||"kc-call", renotify:true, requireInteraction:true,
    icon:"icon-192.png", badge:"icon-192.png", vibrate:[500,200,500,200,900], data:{url:d.url||"/"}
  }));
});
self.addEventListener("notificationclick", function(e){
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type:"window", includeUncontrolled:true}).then(function(cs){
    for (var i=0;i<cs.length;i++){ if ("focus" in cs[i]) return cs[i].focus(); }
    return self.clients.openWindow((e.notification.data&&e.notification.data.url)||"/");
  }));
});
