import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('../src/media-content.js', import.meta.url), 'utf8');
function fixture() {
  let clock = 1_000_000, tick, mutation;
  const reports = [];
  class Player {
    currentTime = 0; paused = true; ended = false; seeking = false;
    readyState = 4; playbackRate = 1; isConnected = true;
    handlers = {};
    addEventListener(event, fn) { this.handlers[event] = fn; }
    fire(event) { this.handlers[event]?.(); }
    querySelectorAll() { return []; }
  }
  const player = new Player();
  const all = [player];
  const document = { querySelectorAll: () => all };
  vm.runInNewContext(source, {
    HTMLMediaElement: Player, document, Date: {now: () => clock},
    MutationObserver: class { constructor(fn) { mutation = fn; } observe() {} },
    setInterval(fn) { tick = fn; }, clearInterval() {}, addEventListener() {},
    chrome: {runtime: {sendMessage(msg) { reports.push(msg); return Promise.resolve({ok:true}); }}},
  });
  return {
    player, reports,
    advance(wall, media = wall / 1000) { clock += wall; player.currentTime += media; },
    start() { player.paused = false; player.fire('playing'); },
    tick() { tick(); },
    add() { const next = new Player(); next.nodeType = 1; all.push(next); mutation([{addedNodes:[next]}]); return next; },
    duration() { return reports.flatMap(r=>r.intervals).reduce((sum,[a,b])=>sum+(b-a)/1000,0); },
  };
}
test('only advancing media counts; pauses, buffering and ended players stop', () => {
  const f = fixture();
  f.advance(5000,0); f.tick(); assert.equal(f.duration(),0);
  f.start(); f.advance(5000); f.tick(); assert.equal(f.duration(),5);
  f.player.paused=true; f.player.fire('pause');
  f.advance(5000,0); f.tick(); assert.equal(f.duration(),5);
  f.start(); f.advance(5000,0); f.player.fire('waiting'); f.tick();
  assert.equal(f.duration(),5);
  f.player.fire('playing'); f.advance(5000); f.player.ended=true; f.player.fire('ended');
  assert.equal(f.duration(),10);
  f.advance(5000,0); f.tick(); assert.equal(f.duration(),10);
});
test('2x playback records elapsed wall time, not doubled video time; seeks do not count', () => {
  const f=fixture(); f.player.playbackRate=2; f.start();
  f.advance(5000,10); f.tick(); assert.equal(f.duration(),5);
  f.advance(1000,100); f.player.seeking=true; f.player.fire('seeking');
  f.player.seeking=false; f.player.fire('seeked'); f.tick(); assert.equal(f.duration(),5);
  f.advance(5000,10); f.tick(); assert.equal(f.duration(),10);
});
test('sleep gaps are discarded and dynamically added players are observed', () => {
  const f=fixture(); f.start(); f.advance(200000,200); f.tick(); assert.equal(f.duration(),0);
  const added=f.add(); assert.equal(typeof added.handlers.playing,'function');
  f.advance(5000); f.tick(); assert.equal(f.duration(),5);
});
