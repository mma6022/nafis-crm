import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const output=path.join(root,".chat-storage-probe.generated.mjs");
try{
  await build({stdin:{resolveDir:root,contents:`
    import {saveChatObject,readChatObject,deleteChatObject,validateChatFile} from "./src/lib/chat-storage";
    const samples=[
      ["image/png",Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jKz8AAAAASUVORK5CYII=","base64")],
      ["application/pdf",Buffer.from("%PDF-1.4\\n1 0 obj <</Type /Catalog>> endobj\\n%%EOF")],
      ["audio/wav",Buffer.from("524946462400000057415645666d74201000000001000100401f0000401f0000010008006461746100000000","hex")]
    ];
    const objects=[];
    try {
      for(const [mime,bytes] of samples){
        const meta=validateChatFile({buffer:bytes,mimetype:mime});
        const object=await saveChatObject(bytes,meta.mime);objects.push(object);
        const received=[];for await(const chunk of readChatObject(object))received.push(chunk);
        if(!Buffer.concat(received).equals(bytes))throw Error("chat_storage_bytes_mismatch");
      }
      console.log("Private image/PDF/voice upload/read byte comparison passed.");
    }catch(error){console.error("Private chat storage probe failed:",error.name);process.exitCode=1;}
    finally {for(const object of objects)await deleteChatObject(object);}
  `},bundle:true,packages:"external",platform:"node",format:"esm",outfile:output,logLevel:"silent"});
  const child=spawn(process.execPath,[output],{cwd:root,stdio:"inherit"});
  const result=await new Promise(resolve=>child.once("exit",code=>resolve(code??1)));
  process.exitCode=result;
}finally{await rm(output,{force:true});}
