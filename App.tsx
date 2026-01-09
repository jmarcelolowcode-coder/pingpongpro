
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
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const addPointRef = useRef<(p: 1 | 2) => void>(() => {});

  const checkSetWinner = (s1: number, s2: number): boolean => {
    if (s1 >= 11 || s2 >= 11) return Math.abs(s1 - s2) >= 2;
    return false;
  };

  const addPoint = useCallback((playerNum: 1 | 2) => {
    if (status !== 'playing') return;
    
    if (playerNum === 1) {
      setPlayer1(prev => {
        const newScore = prev.score + 1;
        if (checkSetWinner(newScore, player2.score)) {
          setWinner(prev.name);
          setStatus('finished');
        }
        return { ...prev, score: newScore };
      });
    } else {
      setPlayer2(prev => {
        const newScore = prev.score + 1;
        if (checkSetWinner(newScore, player1.score)) {
          setWinner(prev.name);
          setStatus('finished');
        }
        return { ...prev, score: newScore };
      });
    }

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

  const resetSet = () => {
    setPlayer1(p => ({ ...p, score: 0 }));
    setPlayer2(p => ({ ...p, score: 0 }));
    setWinner(null);
    setStatus('playing');
  };

  const resetMatch = () => {
    if (window.confirm('Deseja realmente resetar a partida e voltar ao início?')) {
      stopVoiceAssistant();
      setStatus('setup');
      setPlayer1({ name: '', score: 0, sets: 0 });
      setPlayer2({ name: '', score: 0, sets: 0 });
      setWinner(null);
    }
  };

  const confirmSet = () => {
    if (winner === player1.name) setPlayer1(p => ({ ...p, sets: p.sets + 1 }));
    else setPlayer2(p => ({ ...p, sets: p.sets + 1 }));
    
    setHistory(h => ({ ...h, sets: [...h.sets, { p1: player1.score, p2: player2.score }] }));
    resetSet();
  };

  const stopVoiceAssistant = () => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    setIsVoiceActive(false);
    setVoiceConnecting(false);
  };

  const startVoiceAssistant = async () => {
    if (isVoiceActive) return stopVoiceAssistant();
    
    // 1. SOLICITAÇÃO IMEDIATA (SAFARI REQUIREMENT)
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert('Erro ao acessar microfone no iOS. Verifique as permissões do Safari.');
      return;
    }

    setVoiceConnecting(true);

    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContextClass({ sampleRate: 24000 });
      
      // 2. WARM-UP (ESSENCIAL PARA IOS): Cria um som silencioso para "acordar" o hardware
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      gainNode.gain.value = 0;
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      oscillator.start(0);
      oscillator.stop(0.1);

      // 3. FORCE RESUME: Garante que o contexto não fique em 'suspended'
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      
      audioContextRef.current = ctx;

      const apiKey = process.env.API_KEY;
      if (!apiKey) throw new Error("API Key missing");

      const ai = new GoogleGenAI({ apiKey });

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            const source = ctx.createMediaStreamSource(stream);
            const scriptProcessor = ctx.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              // Só envia se o contexto estiver rodando
              if (ctx.state !== 'running') return;
              
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              sessionPromise.then(s => s.sendRealtimeInput({
                media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=24000' }
              }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(ctx.destination);
            setIsVoiceActive(true);
            setVoiceConnecting(false);
          },
          onmessage: async (msg: LiveServerMessage) => {
            const audioData = msg.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && audioContextRef.current) {
              const c = audioContextRef.current;
              // Re-check resume on every message for iOS stability
              if (c.state === 'suspended') await c.resume();
              
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, c.currentTime);
              const buffer = await decodeAudioData(decode(audioData), c, 24000, 1);
              const source = c.createBufferSource();
              source.buffer = buffer;
              source.connect(c.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
              source.onended = () => sourcesRef.current.delete(source);
            }
            if (msg.toolCall?.functionCalls) {
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
          onerror: (e) => {
            console.error('Live API Error:', e);
            stopVoiceAssistant();
          },
          onclose: () => stopVoiceAssistant(),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `Você é o árbitro. Jogadores: ${player1.name} e ${player2.name}. Chame scorePoint ao ouvir quem marcou ponto.`,
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
      console.error('Session error:', e);
      setVoiceConnecting(false);
      stopVoiceAssistant();
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
              className={`p-3 w-12 rounded-lg border transition-all flex items-center justify-center ${
                isVoiceActive ? 'bg-red-500 text-white animate-pulse border-red-400' : 'bg-slate-800 text-slate-300 border-slate-700'
              }`}
            >
              <i className={`fas ${voiceConnecting ? 'fa-spinner fa-spin' : 'fa-microphone'}`}></i>
            </button>
            
            <button onClick={resetSet} className="bg-slate-800 p-3 w-12 rounded-lg border border-slate-700 text-slate-300" title="Zerar Set">
              <i className="fas fa-rotate-left"></i>
            </button>

            <button onClick={resetMatch} className="bg-red-900/20 p-3 w-12 rounded-lg border border-red-900/50 text-red-400" title="Resetar Partida">
              <i className="fas fa-trash-can"></i>
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
          <div className="bg-slate-800 p-10 rounded-3xl text-center max-w-sm w-full mx-4 border border-slate-700 shadow-2xl scale-up-center">
            <div className="text-yellow-500 mb-4"><i className="fas fa-trophy text-6xl"></i></div>
            <h2 className="text-4xl font-black text-white mb-2">{winner} Venceu o Set!</h2>
            <button onClick={confirmSet} className="w-full bg-green-600 hover:bg-green-500 text-white font-black py-5 rounded-2xl text-2xl mt-4 transition-transform active:scale-95">
              PRÓXIMO SET
            </button>
          </div>
        </div>
      )}

      <div className="h-8 bg-slate-900/50 border-t border-slate-800 flex items-center justify-center gap-4">
          <div className="flex items-center gap-2">
            <div className={`w-2 h-2 rounded-full ${((player1.score + player2.score) % 4 < 2) ? 'bg-blue-500' : 'bg-slate-800'}`}></div>
            <span className="text-[10px] text-slate-500 uppercase font-bold">Saque</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-500 uppercase font-bold">Saque</span>
            <div className={`w-2 h-2 rounded-full ${((player1.score + player2.score) % 4 >= 2) ? 'bg-red-500' : 'bg-slate-800'}`}></div>
          </div>
      </div>
    </div>
  );
};

export default App;
