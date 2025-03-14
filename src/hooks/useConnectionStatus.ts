import { GlobalState } from '../global/types';

import useBrowserOnline from './useBrowserOnline';
import { LangFn } from './useLang';

export enum ConnectionStatus {
  waitingForNetwork,
  syncing,
  online,
}

type ConnectionStatusPosition =
  'overlay'
  | 'minimized'
  | 'middleHeader'
  | 'none';

export default function useConnectionStatus(
  lang: LangFn,
  connectionState: GlobalState['connectionState'],
  isSyncing: GlobalState['isSyncing'],
  hasMiddleHeader: boolean,
  isMinimized?: boolean,
) {
  let status: ConnectionStatus;
  const isBrowserOnline = useBrowserOnline();
  if (!isBrowserOnline || connectionState === 'connectionStateConnecting') {
    status = ConnectionStatus.waitingForNetwork;
  } else if (isSyncing) {
    status = ConnectionStatus.syncing;
  } else {
    status = ConnectionStatus.online;
  }

  let position: ConnectionStatusPosition;
  if (status === ConnectionStatus.online) {
    position = 'none';
  } else if (hasMiddleHeader) {
    position = 'middleHeader';
  } else if (isMinimized) {
    position = 'minimized';
  } else {
    position = 'overlay';
  }

  let text: string | undefined;
  if (status === ConnectionStatus.waitingForNetwork) {
    text = lang('WaitingForNetwork');
  } else if (status === ConnectionStatus.syncing) {
    text = lang('Updating');
  }

  if (position === 'middleHeader') {
    text = text!.toLowerCase().replace(/\.+$/, '');
  }

  return {
    connectionStatus: status,
    connectionStatusPosition: position,
    connectionStatusText: text,
  };
}
