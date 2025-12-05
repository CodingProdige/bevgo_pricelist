// /api/catalogue/v1/AI/voice
import { NextResponse } from "next/server";
import OpenAI from "openai";

const ok  = (p={},s=200)=>NextResponse.json({ ok:true, ...p },{ status:s });
const err = (s,t,m,e={})=>NextResponse.json({ ok:false, title:t, message:m, ...e },{ status:s });

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,   // Secure on server
});

/*
  INPUT:
  {
    "utterance": "add 2 cases coke"
  }

  OUTPUT:
  {
    ok: true,
    text: "Sure, adding 2 cases of Coca-Cola now",
    audioBase64: "<mp3 data>"
  }
*/

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const utterance = String(body?.utterance ?? "").trim();

    if (!utterance) {
      return err(400, "Missing Utterance", "Provide 'utterance' text.");
    }

    console.log("VOICE PROCESS → Received:", utterance);

    /*
    ----------------------------------------------------
    1) GPT interprets the utterance
    ----------------------------------------------------
    */

    const completion = await client.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
You are Bevgo's voice ordering assistant.
Interpret what the customer wants and respond naturally.

Keep responses short, clear, friendly and ONLY output the text 
you want spoken aloud — no JSON, no brackets, no formatting.
          `,
        },
        { role: "user", content: utterance },
      ],
      max_tokens: 150,
      temperature: 0.4,
    });

    const replyText =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "I'm sorry, I didn't catch that.";

    /*
    ----------------------------------------------------
    2) Convert reply → MP3 using OpenAI TTS
    ----------------------------------------------------
    */

    const tts = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "verse",       // clean neutral voice
      format: "mp3",
      input: replyText,
    });

    // Convert buffer → base64
    const audioBytes = Buffer.from(await tts.arrayBuffer());
    const audioBase64 = audioBytes.toString("base64");

    return ok({
      message: "Voice processed.",
      text: replyText,
      audioBase64,
    });
  } catch (e) {
    console.error("VOICE PROCESS ERROR:", e);
    return err(500, "Unexpected Error", "Failed to process voice input.", {
      details: String(e?.message || "").slice(0, 300),
    });
  }
}
