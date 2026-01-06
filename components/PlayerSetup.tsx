
import React, { useState } from 'react';

interface PlayerSetupProps {
  onStart: (p1Name: string, p2Name: string) => void;
}

export const PlayerSetup: React.FC<PlayerSetupProps> = ({ onStart }) => {
  const [p1, setP1] = useState('');
  const [p2, setP2] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (p1.trim() && p2.trim()) {
      onStart(p1.trim(), p2.trim());
    }
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-slate-900">
      <div className="w-full max-w-md p-8 rounded-3xl bg-slate-800 shadow-2xl border border-slate-700">
        <div className="flex items-center justify-center mb-8">
          <div className="bg-blue-600 p-4 rounded-full shadow-lg shadow-blue-500/20">
            <i className="fas fa-table-tennis-paddle-ball text-4xl text-white"></i>
          </div>
        </div>
        <h1 className="text-3xl font-black text-center mb-2 tracking-tight">PING PONG PRO</h1>
        <p className="text-slate-400 text-center mb-8">Cadastre os jogadores para iniciar</p>
        
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Jogador 1</label>
            <input
              type="text"
              required
              placeholder="Ex: Carlos"
              className="w-full bg-slate-700 border-none rounded-xl p-4 text-white focus:ring-2 focus:ring-blue-500 transition-all outline-none text-lg"
              value={p1}
              onChange={(e) => setP1(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-400 uppercase tracking-wider">Jogador 2</label>
            <input
              type="text"
              required
              placeholder="Ex: Ana"
              className="w-full bg-slate-700 border-none rounded-xl p-4 text-white focus:ring-2 focus:ring-blue-500 transition-all outline-none text-lg"
              value={p2}
              onChange={(e) => setP2(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-4 rounded-xl shadow-lg shadow-blue-600/30 transition-all active:scale-95 text-xl"
          >
            Iniciar Partida
          </button>
        </form>
      </div>
    </div>
  );
};
