import React from 'react';
import { AssistantAction } from '../utils/mobileAssistant';

interface ActionPromptCardProps {
  action?: AssistantAction | null;
  onDismiss?: () => void;
  soundFxEnabled?: boolean;
}

/**
 * ActionPromptCard was previously used as an intermediate confirmation popup.
 * Per master requirements, all voice actions are now executed directly without
 * showing any confirmation popups or EXECUTE/CANCEL buttons.
 * This component returns null to ensure no intermediate action popups ever appear.
 */
export const ActionPromptCard: React.FC<ActionPromptCardProps> = () => {
  return null;
};
