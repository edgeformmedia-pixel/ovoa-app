// The page side of a game's online room (gameroom.ts), kept apart from it so
// sites.ts and its tests don't load the Durable Object runtime.

/**
 * window.ovoaRoom, put at the top of every game page: connects to the game's
 * room, reconnects when the phone drops, and hands the game what happens.
 *   ovoaRoom.on("ready", ({ seat, players, state }) => ...)   joined (again)
 *   ovoaRoom.on("players", (players) => ...)                  someone came or left
 *   ovoaRoom.on("message", (data, seat) => ...)               another phone's send()
 *   ovoaRoom.on("state", (data, seat) => ...)                 another phone's setState()
 *   ovoaRoom.on("status", (online) => ...)
 *   ovoaRoom.send(data), ovoaRoom.setState(data), ovoaRoom.seat, ovoaRoom.players, ovoaRoom.state
 */
export const ROOM_SCRIPT = `<script>(function(){var h={},q=[],ws,wait=500,R=window.ovoaRoom={seat:null,players:[],state:null,online:false,
on:function(e,f){(h[e]=h[e]||[]).push(f);if(e==="ready"&&R.online)f({seat:R.seat,players:R.players,state:R.state});return R},
send:function(d){put({type:"send",data:d})},setState:function(d){R.state=d;put({type:"state",data:d})}};
function fire(e,a,b){(h[e]||[]).forEach(function(f){try{f(a,b)}catch(x){console.error(x)}})}
function put(m){var s=JSON.stringify(m);if(ws&&ws.readyState===1)ws.send(s);else q.push(s)}
function go(){var u=(location.protocol==="https:"?"wss://":"ws://")+location.host+location.pathname.replace(/\\/+$/,"")+"/room";
try{ws=new WebSocket(u)}catch(x){return later()}
ws.onmessage=function(ev){var m;try{m=JSON.parse(ev.data)}catch(x){return}
if(m.type==="welcome"){wait=500;R.seat=m.seat;R.me=m.you;R.players=m.players;R.state=m.state;R.online=true;fire("status",true);
while(q.length)ws.send(q.shift());fire("ready",{seat:m.seat,players:m.players,state:m.state})}
else if(m.type==="players"){R.players=m.players;fire("players",m.players)}
else if(m.type==="message")fire("message",m.data,m.seat);
else if(m.type==="state"){R.state=m.data;fire("state",m.data,m.seat)}};
ws.onclose=function(){if(R.online){R.online=false;fire("status",false)}later()}}
function later(){setTimeout(go,wait);wait=Math.min(wait*2,10000)}
setInterval(function(){if(ws&&ws.readyState===1)ws.send('{"type":"ping"}')},25000);go()})();</script>`;
