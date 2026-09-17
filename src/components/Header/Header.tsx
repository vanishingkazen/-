import React from 'react';
import { Settings, LogOut } from 'lucide-react';
import { Button } from '../ui/button';
import { useToast } from '../../contexts/toast';

interface HeaderProps {
  onOpenSettings: () => void;
}

export function Header({ onOpenSettings }: HeaderProps) {
  const { showToast } = useToast();

  // Handle logout - clear API key and reload app
  const handleLogout = async () => {
    try {
      // Update config with empty API key
      await window.electronAPI.updateConfig({
        apiKey: '',
      });
      
      showToast('Success', 'Logged out successfully', 'success');
      
      // Reload the app after a short delay
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (error) {
      console.error('Error logging out:', error);
      showToast('Error', 'Failed to log out', 'error');
    }
  };

  return (
    <div className="bg-black p-2 border-b border-white/10 flex items-center justify-between">
      <div />
      
      <div className="flex items-center space-x-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-white/70 hover:text-white hover:bg-white/10"
          onClick={onOpenSettings}
          title="Settings"
        >
          <Settings className="h-4 w-4 mr-1" />
          <span className="text-xs">Settings</span>
        </Button>
        
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-red-400/80 hover:text-red-400 hover:bg-white/10"
          onClick={handleLogout}
          title="Log Out"
        >
          <LogOut className="h-4 w-4 mr-1" />
          <span className="text-xs">Log Out</span>
        </Button>
      </div>
    </div>
  );
}
