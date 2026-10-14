const WASM_BYTES = new Uint8Array([
  0,97,115,109,1,0,0,0,1,4,1,96,0,1,127,3,2,1,0,5,3,1,0,1,12,2,0,11,
  112,4,11,0,65,23,11]);

export default {
  async fetch() {
    const out = {};
    try {
      const mod = await WebAssembly.compile(WASM_BYTES);
      const inst = await WebAssembly.instantiate(mod, {});
      out.asyncCompileInstantiate = { ok: true, v: inst.exports.a ? inst.exports.a() : 'no-export' };
    } catch (e) { out.asyncCompileInstantiate = { ok: false, err: String(e && e.message || e) }; }
    try {
      const r = await WebAssembly.instantiateStreaming(Promise.resolve(new Response(WASM_BYTES, {
        headers: { 'Content-Type': 'application/wasm' } })), {});
      out.streaming = { ok: true, v: r.instance.exports.a ? r.instance.exports.a() : 'no-export' };
    } catch (e) { out.streaming = { ok: false, err: String(e && e.message || e) }; }
    try {
      const m = await import('data:text/javascript,export const x=7;');
      out.literalDataImport = { ok: true, v: m.x };
    } catch (e) { out.literalDataImport = { ok: false, err: String(e && e.message || e) }; }
    return Response.json(out);
  },
};
