import React from 'react';
import { Button } from './ui/button';
import { COMMAND_KEY } from '../utils/platform';

interface WelcomeScreenProps {
  onOpenSettings: () => void;
}

export const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onOpenSettings }) => {
  return (
    <div className="bg-white/[0.86] min-h-screen backdrop-blur-xl flex flex-col items-center justify-center p-6">
      <div className="max-w-md w-full bg-white/[0.72] border border-black/10 rounded-xl p-6 shadow-lg">
        <h1 className="text-2xl font-bold text-black mb-6 flex items-center gap-2">
          <span>steamgamecode</span>
          <span className="text-sm font-normal px-2 py-0.5 bg-blue-500/20 text-blue-600 rounded-md">Unlocked Edition</span>
        </h1>
        
        <div className="mb-8">
          <h2 className="text-lg font-medium text-black mb-3">Welcome to steamgamecode</h2>
          <p className="text-black/65 text-sm mb-4">
            This application helps you ace technical interviews by providing AI-powered
            solutions to coding problems.
          </p>
          <div className="bg-white/[0.52] border border-black/10 rounded-lg p-4 mb-4">
            <h3 className="text-black/80 font-medium mb-2">Global Shortcuts</h3>
            <ul className="space-y-2">
              <li className="flex justify-between text-sm">
                <span className="text-black/65">Toggle Visibility</span>
                <span className="text-black/80 font-mono">{COMMAND_KEY}+B</span>
              </li>
              <li className="flex justify-between text-sm">
                <span className="text-black/65">Mouse Shake</span>
                <span className="text-black/80">快速左右晃动 4 次</span>
              </li>
              <li className="flex justify-between text-sm">
                <span className="text-black/65">New Session</span>
                <span className="text-black/80">{COMMAND_KEY}+N</span>
              </li>
              <li className="flex justify-between text-sm">
                <span className="text-black/65">Take Screenshot</span>
                <span className="text-black/80">{COMMAND_KEY}+H</span>
              </li>
              <li className="flex justify-between text-sm">
                <span className="text-black/65">Delete Last Screenshot</span>
                <span className="text-black/80">{COMMAND_KEY}+L</span>
              </li>
              <li className="flex justify-between text-sm">
                <span className="text-black/65">Process Screenshots</span>
                <span className="text-black/80">{COMMAND_KEY}+Enter</span>
              </li>
              <li className="flex justify-between text-sm">
                <span className="text-black/65">Reset View</span>
                <span className="text-black/80">{COMMAND_KEY}+R</span>
              </li>
              <li className="flex justify-between text-sm">
                <span className="text-black/65">Quit App</span>
                <span className="text-black/80">{COMMAND_KEY}+Q</span>
              </li>
            </ul>
          </div>
        </div>
        
        <div className="bg-white/[0.52] border border-black/10 rounded-lg p-4 mb-6">
          <h3 className="text-black/80 font-medium mb-2">Getting Started</h3>
          <p className="text-black/65 text-sm mb-3">
            Before using the application, you need to configure your OpenAI API key.
          </p>
          <Button 
            className="w-full px-4 py-3 bg-black text-white rounded-xl font-medium hover:bg-black/80 transition-colors flex items-center justify-center gap-2"
            onClick={onOpenSettings}
          >
            Open Settings
          </Button>
        </div>
        
        <div className="text-black/45 text-xs text-center">
          Start by taking screenshots of your coding problem ({COMMAND_KEY}+H)
        </div>
      </div>
    </div>
  );
};
