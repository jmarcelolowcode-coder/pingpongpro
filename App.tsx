
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { PlayerSetup } from './components/PlayerSetup';
import { ScoreButton } from './components/ScoreButton';
import { Player, GameStatus, MatchHistory } from './types';
import { GoogleGenAI, Modality, Type, LiveServerMessage } from '@google/genai';

// Auxiliares de áudio
function encode(bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
  }
  return buffer;
}

const App: React.FC = () => {
  const [status, setStatus] = useState<GameStatus>('setup');
  const [player1, setPlayer1] = useState<Player>({ name: '', score: 0, sets: 0 });
  const [player2, setPlayer2] = useState<Player>({ name: '', score: 0, sets: 0 });
  const [winner, setWinner] = useState<string | null>(null);

  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [voiceConnecting, setVoiceConnecting] = useState(false);
  
  const sessionRef = useRef<any>(null);
  const audioContextsRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const nextStartTimeRef = useRef(0);
  const addPointRef = useRef<(p: 1 | 2) => void>(() => {});

  const checkSetWinner = (s1: number, s2: number): boolean => {
    if (s1 >= 11 || s2 >= 11) return Math.abs(s1 - s2) >= 2;
    return false;
  };

  const addPoint = useCallback((playerNum: 1 | 2) => {
    if (status !== 'playing') return;
    const setter = playerNum === 1 ? setPlayer1 : setPlayer2;
    const otherScore = playerNum === 1 ? player2.score : player1.score;

    setter(prev => {
      const newScore = prev.score + 1;
      if (checkSetWinner(newScore, otherScore)) {
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
    setStatus('playing');
  };

  const confirmSet = () => {
    if (winner === player1.name) setPlayer1(p => ({ ...p, sets: p.sets + 1, score: 0 }));
    else setPlayer2(p => ({ ...p, sets: p.sets + 1, score: 0 }));
    if (winner === player1.name) setPlayer2(p => ({ ...p, score: 0 }));
    else setPlayer1(p => ({ ...p, score: 0 }));
    setWinner(null);
    setStatus('playing');
  };

  const resetMatch = () => {
    if (confirm('Zerar partida?')) {
      setStatus('setup');
      setWinner(null);
      stopVoiceAssistant();
    }
  };

  const stopVoiceAssistant = () => {
    if (sessionRef.current) sessionRef.current.close();
    if (audioContextsRef.current) {
      audioContextsRef.current.input.close();
      audioContextsRef.current.output.close();
    }
    sessionRef.current = null;
    audioContextsRef.current = null;
    setIsVoiceActive(false);
    setVoiceConnecting(false);
  };

  const startVoiceAssistant = async () => {
    if (isVoiceActive) return stopVoiceAssistant();
    setVoiceConnecting(true);

    try {
      const apiKey = process.env.API_KEY;
      if (!apiKey) {
        alert("API_KEY não configurada no Vercel.");
        setVoiceConnecting(false);
        return;
      }

      const ai = new GoogleGenAI({ apiKey });
      const inputCtx = new AudioContext({ sampleRate: 16000 });
      const outputCtx = new AudioContext({ sampleRate: 24000 });
      audioContextsRef.current = { input: inputCtx, output: outputCtx };

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
            const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && audioContextsRef.current) {
              const ctx = audioContextsRef.current.output;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const src = ctx.createBufferSource();
              src.buffer = buffer;
              src.connect(ctx.destination);
              src.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
            }
            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'scorePoint') {
                  const target = fc.args.playerName.toLowerCase();
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
          systemInstruction: `Árbitro de ping pong. Jogadores: ${player1.name} e ${player2.name}.`,
          tools: [{
            functionDeclarations: [{
              name: 'scorePoint',
              description: 'Adiciona ponto.',
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
    <div className="fixed inset-0 flex flex-col bg-slate-950 text-white overflow-hidden">
      {/* Header com os botões, incluindo o Microfone */}
      <header className="h-20 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-6 shadow-xl">
        <div className="flex items-center gap-3">
          <i className="fas fa-table-tennis-paddle-ball text-blue-500 text-2xl"></i>
          <div className="hidden sm:block">
            <h1 className="text-xs font-black tracking-widest text-slate-500 uppercase">Ping Pong Pro</h1>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center bg-slate-800/80 px-4 py-2 rounded-xl border border-slate-700">
            <span className="text-blue-400 font-bold mr-2">{player1.name}</span>
            <span className="bg-blue-500/20 px-2 rounded text-blue-500 font-black mr-4">{player1.sets}</span>
            <span className="text-slate-600 font-black text-xs mr-4">VS</span>
            <span className="bg-red-500/20 px-2 rounded text-red-500 font-black mr-2">{player2.sets}</span>
            <span className="text-red-400 font-bold">{player2.name}</span>
          </div>

          <div className="flex gap-2">
            <button 
              onClick={startVoiceAssistant}
              disabled={voiceConnecting}
              className={`p-3 rounded-xl border transition-all ${
                isVoiceActive ? 'bg-red-500/20 border-red-500 text-red-500 animate-pulse-red' : 'bg-slate-800 border-slate-700 text-slate-400'
              }`}
            >
              <i className={`fas ${voiceConnecting ? 'fa-spinner fa-spin' : 'fa-microphone'}`}></i>
            </button>
            <button onClick={() => setStatus('setup')} className="bg-slate-800 p-3 rounded-xl border border-slate-700 text-slate-400">
              <i className="fas fa-cog"></i>
            </button>
            <button onClick={resetMatch} className="bg-red-900/20 p-3 rounded-xl border border-red-800/50 text-red-500">
              <i className="fas fa-power-off"></i>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 flex p-4 gap-4">
        <ScoreButton playerName={player1.name} score={player1.score} color="blue" onClick={() => addPoint(1)} disabled={status === 'finished'} />
        <ScoreButton playerName={player2.name} score={player2.score} color="red" onClick={() => addPoint(2)} disabled={status === 'finished'} />
      </main>

      {status === 'finished' && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm">
          <div className="bg-slate-800 p-12 rounded-3xl text-center border border-slate-700 shadow-2xl">
            <i className="fas fa-trophy text-6xl text-yellow-500 mb-6 block"></i>
            <h2 className="text-4xl font-black mb-2 uppercase">{winner} Venceu!</h2>
            <p className="text-slate-400 mb-8 text-xl">Placar final: {player1.score} - {player2.score}</p>
            <button onClick={confirmSet} className="w-full bg-green-600 hover:bg-green-500 text-white font-black py-5 rounded-2xl text-2xl shadow-lg shadow-green-600/20">
              PRÓXIMO SET
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
