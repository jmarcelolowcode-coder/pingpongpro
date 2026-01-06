
import React from 'react';

interface ScoreButtonProps {
  playerName: string;
  score: number;
  color: 'blue' | 'red';
  onClick: () => void;
  disabled?: boolean;
}

export const ScoreButton: React.FC<ScoreButtonProps> = ({ playerName, score, color, onClick, disabled }) => {
  const colorClasses = {
    blue: 'bg-blue-600 active:bg-blue-700 shadow-blue-900/40 border-blue-500',
    red: 'bg-red-600 active:bg-red-700 shadow-red-900/40 border-red-500',
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`
        flex-1 h-full flex flex-col items-center justify-center 
        transition-all duration-75 select-none touch-none
        border-b-8 rounded-2xl
        ${colorClasses[color]}
        ${disabled ? 'opacity-50 grayscale' : 'hover:brightness-110 active:translate-y-1 active:border-b-0'}
      `}
    >
      <span className="text-xl md:text-3xl font-black mb-4 uppercase tracking-widest opacity-80">
        {playerName}
      </span>
      <span className="text-8xl md:text-[12rem] font-black score-display leading-none">
        {score}
      </span>
      <div className="mt-8 bg-white/20 px-6 py-2 rounded-full backdrop-blur-sm">
        <i className="fas fa-plus text-2xl"></i>
      </div>
    </button>
  );
};
