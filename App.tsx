
import React, { useState, useCallback, useEffect, useRef } from 'react';
import { PlayerSetup } from './components/PlayerSetup';
import { ScoreButton } from './components/ScoreButton';
import { Player, GameStatus, MatchHistory } from './types';
import { GoogleGenAI, Modality, Type, LiveServerMessage } from "@google/genai";

// Funções auxiliares para áudio PCM
function encode(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const App: React.FC = () => {
  const [status, setStatus] = useState<GameStatus>('setup');
  const [player1, setPlayer1] = useState<Player>({ name: '', score: 0, sets: 0 });
  const [player2, setPlayer2] = useState<Player>({ name: '', score: 0, sets: 0 });
  const [history, setHistory] = useState<MatchHistory>({ player1Sets: 0, player2Sets: 0, sets: [] });
  const [winner, setWinner] = useState<string | null>(null);

  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [voiceConnecting, setVoiceConnecting] = useState(false);
  
  const sessionRef = useRef<any>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const addPointRef = useRef<(p: 1 | 2) => void>(() => {});

  const checkSetWinner = (s1: number, s2: number): boolean => {
    if (s1 >= 11 || s2 >= 11) return Math.abs(s1 - s2) >= 2;
    return false;
  };

  const addPoint = useCallback((playerNum: 1 | 2) => {
    if (status !== 'playing') return;
    const setter = playerNum === 1 ? setPlayer1 : setPlayer2;
    const opponentScore = playerNum === 1 ? player2.score : player1.score;

    setter(prev => {
      const newScore = prev.score + 1;
      if (checkSetWinner(newScore, opponentScore)) {
        setWinner(prev.name);
        setStatus('finished');
      }
      return { ...prev, score: newScore };
    });

    if ('vibrate' in navigator) navigator.vibrate(50);
  }, [player1.score, player2.score, status]);

  useEffect(() => {
    addPointRef.current = addPoint;
  }, [addPoint]);

  const startMatch = (p1Name: string, p2Name: string) => {
    setPlayer1({ name: p1Name, score: 0, sets: 0 });
    setPlayer2({ name: p2Name, score: 0, sets: 0 });
    setHistory({ player1Sets: 0, player2Sets: 0, sets: [] });
    setStatus('playing');
  };

  const confirmSet = () => {
    if (winner === player1.name) setPlayer1(p => ({ ...p, sets: p.sets + 1 }));
    else setPlayer2(p => ({ ...p, sets: p.sets + 1 }));
    
    setHistory(h => ({ ...h, sets: [...h.sets, { p1: player1.score, p2: player2.score }] }));
    setPlayer1(p => ({ ...p, score: 0 }));
    setPlayer2(p => ({ ...p, score: 0 }));
    setWinner(null);
    setStatus('playing');
  };

  const stopVoiceAssistant = () => {
    if (sessionRef.current) sessionRef.current.close();
    [inputAudioContextRef, outputAudioContextRef].forEach(ref => {
      if (ref.current) ref.current.close().catch(() => {});
      ref.current = null;
    });
    sourcesRef.current.forEach(s => s.stop());
    sourcesRef.current.clear();
    setIsVoiceActive(false);
    setVoiceConnecting(false);
  };

  const startVoiceAssistant = async () => {
    if (isVoiceActive) return stopVoiceAssistant();
    setVoiceConnecting(true);

    try {
      const apiKey = process.env.API_KEY;
      if (!apiKey) throw new Error("API Key missing");

      const ai = new GoogleGenAI({ apiKey });
      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      inputAudioContextRef.current = inputCtx;
      outputAudioContextRef.current = outputCtx;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            const source = inputCtx.createMediaStreamSource(stream);
            const scriptProcessor = inputCtx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              sessionPromise.then(s => s.sendRealtimeInput({
                media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' }
              }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
            setIsVoiceActive(true);
            setVoiceConnecting(false);
          },
          onmessage: async (msg: LiveServerMessage) => {
            const audio = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audio && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }
            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'scorePoint') {
                  const target = (fc.args as any).playerName?.toLowerCase() || "";
                  if (target.includes(player1.name.toLowerCase())) addPointRef.current(1);
                  else if (target.includes(player2.name.toLowerCase())) addPointRef.current(2);
                }
                sessionPromise.then(s => s.sendToolResponse({
                  functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } }
                }));
              }
            }
          },
          onerror: stopVoiceAssistant,
          onclose: stopVoiceAssistant,
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `Árbitro de ping pong para ${player1.name} e ${player2.name}. Use scorePoint para registrar pontos.`,
          tools: [{
            functionDeclarations: [{
              name: 'scorePoint',
              parameters: { type: Type.OBJECT, properties: { playerName: { type: Type.STRING } }, required: ['playerName'] }
            }]
          }]
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (e) {
      console.error(e);
      setVoiceConnecting(false);
    }
  };

  if (status === 'setup') return <PlayerSetup onStart={startMatch} />;

  return (
    <div className="fixed inset-0 flex flex-col bg-slate-950 overflow-hidden">
      <div className="h-20 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-6 z-10 shadow-lg">
        <div className="flex items-center gap-2 opacity-60">
          <i className="fas fa-table-tennis-paddle-ball text-xl text-blue-500"></i>
          <span className="text-xs font-black tracking-widest text-slate-400 uppercase">Pro Score</span>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-4 bg-slate-800/50 px-4 py-2 rounded-xl border border-slate-700/50">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-slate-300">{player1.name}</span>
              <span className="text-xl font-black text-blue-500 bg-blue-500/10 px-2 rounded">{player1.sets}</span>
            </div>
            <span className="text-[10px] font-black text-slate-600">VS</span>
            <div className="flex items-center gap-2">
              <span className="text-xl font-black text-red-500 bg-red-500/10 px-2 rounded">{player2.sets}</span>
              <span className="text-sm font-bold text-slate-300">{player2.name}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <button 
              onClick={startVoiceAssistant}
              disabled={voiceConnecting}
              className={`p-3 rounded-lg border transition-all ${isVoiceActive ? 'bg-red-500 text-white animate-pulse' : 'bg-slate-800 text-slate-300'}`}
            >
              <i className={`fas ${voiceConnecting ? 'fa-spinner fa-spin' : 'fa-microphone'}`}></i>
            </button>
            <button onClick={() => setStatus('setup')} className="bg-slate-800 p-3 rounded-lg border border-slate-700 text-slate-300">
              <i className="fas fa-cog"></i>
            </button>
          </div>
        </div>
      </div>
      <div className="flex-1 flex p-4 gap-4">
        <ScoreButton playerName={player1.name} score={player1.score} color="blue" onClick={() => addPoint(1)} disabled={status === 'finished'} />
        <ScoreButton playerName={player2.name} score={player2.score} color="red" onClick={() => addPoint(2)} disabled={status === 'finished'} />
      </div>
      {status === 'finished' && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md">
          <div className="bg-slate-800 p-10 rounded-3xl text-center max-w-sm w-full mx-4 border border-slate-700 shadow-2xl">
            <h2 className="text-4xl font-black text-white mb-2">{winner} Venceu!</h2>
            <button onClick={confirmSet} className="w-full bg-green-600 hover:bg-green-500 text-white font-black py-5 rounded-2xl text-2xl mt-4">PRÓXIMO SET</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
