
import React, { useState, useCallback, useRef } from 'react';
import { PlayerSetup } from './components/PlayerSetup';
import { ScoreButton } from './components/ScoreButton';
import { Player, GameStatus, MatchHistory } from './types';
import { GoogleGenAI, Modality, Type, LiveServerMessage } from '@google/genai';

// Auxiliares de codificação/decodificação para Live API
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
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

  // Estados de Voz
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [voiceConnecting, setVoiceConnecting] = useState(false);
  const sessionRef = useRef<any>(null);
  const audioContextsRef = useRef<{ input: AudioContext; output: AudioContext } | null>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Refs para as funções de pontuação serem acessadas pelos callbacks da Live API sem stale closures
  const addPointRef = useRef<(p: 1 | 2) => void>(() => {});

  const checkSetWinner = (s1: number, s2: number): boolean => {
    if (s1 >= 11 || s2 >= 11) {
      if (Math.abs(s1 - s2) >= 2) return true;
    }
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
  }, [player1.name, player2.name, player1.score, player2.score, status]);

  // Atualiza a ref toda vez que addPoint ou resetSet mudar
  addPointRef.current = addPoint;

  const startMatch = (p1Name: string, p2Name: string) => {
    setPlayer1({ name: p1Name, score: 0, sets: 0 });
    setPlayer2({ name: p2Name, score: 0, sets: 0 });
    setHistory({ player1Sets: 0, player2Sets: 0, sets: [] });
    setStatus('playing');
  };

  const resetSet = useCallback(() => {
    setPlayer1(prev => ({ ...prev, score: 0 }));
    setPlayer2(prev => ({ ...prev, score: 0 }));
    setWinner(null);
    setStatus('playing');
  }, []);

  const confirmSet = () => {
    if (winner === player1.name) {
      setPlayer1(prev => ({ ...prev, sets: prev.sets + 1 }));
    } else {
      setPlayer2(prev => ({ ...prev, sets: prev.sets + 1 }));
    }
    setHistory(prev => ({
      ...prev,
      sets: [...prev.sets, { p1: player1.score, p2: player2.score }]
    }));
    resetSet();
  };

  const resetMatch = () => {
    if (confirm('Tem certeza que deseja zerar a partida inteira?')) {
      setStatus('setup');
      setWinner(null);
      setPlayer1({ name: '', score: 0, sets: 0 });
      setPlayer2({ name: '', score: 0, sets: 0 });
    }
  };

  const stopVoiceAssistant = () => {
    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    if (audioContextsRef.current) {
      audioContextsRef.current.input.close().catch(() => {});
      audioContextsRef.current.output.close().catch(() => {});
      audioContextsRef.current = null;
    }
    setIsVoiceActive(false);
  };

  const startVoiceAssistant = async () => {
    if (isVoiceActive) {
      stopVoiceAssistant();
      return;
    }

    setVoiceConnecting(true);
    try {
      const apiKey = process.env.API_KEY;
      if (!apiKey) throw new Error("API Key não encontrada");

      const ai = new GoogleGenAI({ apiKey });
      
      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextsRef.current = { input: inputCtx, output: outputCtx };

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const scorePointDeclaration = {
        name: 'scorePoint',
        parameters: {
          type: Type.OBJECT,
          description: 'Adiciona um ponto para um dos jogadores.',
          properties: {
            playerName: {
              type: Type.STRING,
              description: 'O nome do jogador que marcou o ponto.',
            }
          },
          required: ['playerName'],
        },
      };

      const resetSetDeclaration = {
        name: 'resetSet',
        parameters: { type: Type.OBJECT, properties: {} },
        description: 'Zera a pontuação do set atual.'
      };

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
              const pcmBlob = {
                data: encode(new Uint8Array(int16.buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              sessionPromise.then(s => s.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(inputCtx.destination);
            setVoiceConnecting(false);
            setIsVoiceActive(true);
          },
          onmessage: async (message: LiveServerMessage) => {
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && audioContextsRef.current) {
              const ctx = audioContextsRef.current.output;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(audioData), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(ctx.destination);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
              sourcesRef.current.add(source);
            }

            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                if (fc.name === 'scorePoint') {
                  const target = fc.args.playerName.toLowerCase();
                  if (target.includes(player1.name.toLowerCase())) addPointRef.current(1);
                  else if (target.includes(player2.name.toLowerCase())) addPointRef.current(2);
                } else if (fc.name === 'resetSet') {
                  resetSet();
                }
                sessionPromise.then(s => s.sendToolResponse({
                  functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } }
                }));
              }
            }
          },
          onerror: () => stopVoiceAssistant(),
          onclose: () => stopVoiceAssistant(),
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          systemInstruction: `Você é um árbitro de tênis de mesa. Jogadores: ${player1.name} e ${player2.name}. Ouça comandos de pontos e use scorePoint. Seja breve.`,
          tools: [{ functionDeclarations: [scorePointDeclaration, resetSetDeclaration] }],
        },
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error("Erro ao iniciar voz:", err);
      setVoiceConnecting(false);
    }
  };

  if (status === 'setup') {
    return <PlayerSetup onStart={startMatch} />;
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-slate-950 overflow-hidden">
      {/* Header */}
      <div className="h-20 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-6 z-10 shadow-lg">
        <div className="flex items-center gap-2 opacity-60">
          <i className="fas fa-table-tennis-paddle-ball text-xl text-blue-500"></i>
          <span className="text-xs font-black tracking-widest text-slate-400 uppercase">Pro Score</span>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-4 bg-slate-800/50 px-4 py-2 rounded-xl border border-slate-700/50">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-slate-300 truncate max-w-[80px]">{player1.name}</span>
              <span className="text-xl font-black text-blue-500 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">{player1.sets}</span>
            </div>
            <span className="text-[10px] font-black text-slate-600">VS</span>
            <div className="flex items-center gap-2">
              <span className="text-xl font-black text-red-500 bg-red-500/10 px-2 py-0.5 rounded border border-red-500/20">{player2.sets}</span>
              <span className="text-sm font-bold text-slate-300 truncate max-w-[80px]">{player2.name}</span>
            </div>
          </div>

          <div className="h-8 w-[1px] bg-slate-700"></div>

          <div className="flex gap-2">
            <button 
              onClick={startVoiceAssistant}
              disabled={voiceConnecting}
              className={`p-3 rounded-lg transition-all border ${
                isVoiceActive 
                  ? 'bg-red-500/20 border-red-500 text-red-500 animate-pulse-red' 
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
              }`}
            >
              <i className={`fas ${voiceConnecting ? 'fa-circle-notch fa-spin' : 'fa-microphone'}`}></i>
            </button>
            <button onClick={resetSet} className="bg-slate-800 hover:bg-slate-700 p-3 rounded-lg border border-slate-700">
              <i className="fas fa-rotate-left text-slate-300"></i>
            </button>
            <button onClick={resetMatch} className="bg-red-900/30 hover:bg-red-900/50 p-3 rounded-lg border border-red-800/50">
              <i className="fas fa-xmark text-red-400"></i>
            </button>
          </div>
        </div>
      </div>

      {/* Main Score Area */}
      <div className="flex-1 flex p-4 gap-4 bg-slate-950">
        <ScoreButton 
          playerName={player1.name} 
          score={player1.score} 
          color="blue" 
          onClick={() => addPoint(1)}
          disabled={status === 'finished'}
        />
        <ScoreButton 
          playerName={player2.name} 
          score={player2.score} 
          color="red" 
          onClick={() => addPoint(2)}
          disabled={status === 'finished'}
        />
      </div>

      {/* Winner Overlay */}
      {status === 'finished' && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md">
          <div className="bg-slate-800 p-10 rounded-3xl border border-slate-700 shadow-2xl text-center max-w-sm w-full mx-4 animate-in zoom-in duration-300">
            <div className="mb-6 inline-flex p-5 rounded-full bg-yellow-500/20 text-yellow-500">
              <i className="fas fa-trophy text-6xl"></i>
            </div>
            <h2 className="text-4xl font-black text-white mb-2 uppercase tracking-tight">{winner} Venceu!</h2>
            <p className="text-slate-400 mb-8 text-lg">Placar: {player1.score} - {player2.score}</p>
            <button
              onClick={confirmSet}
              className="w-full bg-green-600 hover:bg-green-500 text-white font-black py-5 rounded-2xl text-2xl shadow-xl transition-all active:scale-95"
            >
              PRÓXIMO SET
            </button>
          </div>
        </div>
      )}

      {/* Footer / Server Indicator */}
      <div className="h-12 bg-slate-900/50 flex items-center justify-center gap-8 px-4 border-t border-slate-800">
         <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${((player1.score + player2.score) % 4 < 2) ? 'bg-blue-500 animate-pulse' : 'bg-slate-800'}`}></div>
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Saque</span>
         </div>
         {isVoiceActive && (
           <div className="flex items-center gap-2 px-4 py-1 bg-red-500/10 rounded-full border border-red-500/20">
             <span className="text-[10px] font-bold text-red-500 uppercase tracking-widest">Árbitro Online</span>
           </div>
         )}
         <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Saque</span>
            <div className={`w-3 h-3 rounded-full ${((player1.score + player2.score) % 4 >= 2) ? 'bg-red-500 animate-pulse' : 'bg-slate-800'}`}></div>
         </div>
      </div>
    </div>
  );
};

export default App;
