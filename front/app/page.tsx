import Image from "next/image";
import { useState } from "react";

export default function Home() {
  const [prompt, setPrompt] = useState("");
  async function sendRequest() {
    console.log("Sending request with prompt:", prompt);
  }

  return (
    <div>
      <input value={prompt} onChange={(e) => setPrompt(e.target.value)}></input>
      <button onClick={sendRequest}></button>
    </div>
  );
}
