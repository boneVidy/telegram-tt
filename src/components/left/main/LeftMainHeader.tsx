import React, {
  FC, memo, useCallback, useMemo,
} from '../../../lib/teact/teact';
import { getDispatch, withGlobal } from '../../../lib/teact/teactn';

import { ISettings, LeftColumnContent } from '../../../types';
import { ApiChat } from '../../../api/types';
import { GlobalState } from '../../../global/types';

import {
  ANIMATION_LEVEL_MAX, APP_NAME, APP_VERSION, FEEDBACK_URL,
} from '../../../config';
import { IS_SINGLE_COLUMN_LAYOUT } from '../../../util/environment';
import buildClassName from '../../../util/buildClassName';
import { formatDateToString } from '../../../util/dateFormat';
import switchTheme from '../../../util/switchTheme';
import { setPermanentWebVersion } from '../../../util/permanentWebVersion';
import { clearWebsync } from '../../../util/websync';
import { selectCurrentMessageList, selectTheme } from '../../../modules/selectors';
import { isChatArchived } from '../../../modules/helpers';
import useLang from '../../../hooks/useLang';
import { disableHistoryBack } from '../../../hooks/useHistoryBack';
import useConnectionStatus from '../../../hooks/useConnectionStatus';

import DropdownMenu from '../../ui/DropdownMenu';
import MenuItem from '../../ui/MenuItem';
import Button from '../../ui/Button';
import SearchInput from '../../ui/SearchInput';
import PickerSelectedItem from '../../common/PickerSelectedItem';
import Switcher from '../../ui/Switcher';
import ShowTransition from '../../ui/ShowTransition';
import ConnectionStatusOverlay from '../ConnectionStatusOverlay';

import './LeftMainHeader.scss';

type OwnProps = {
  content: LeftColumnContent;
  contactsFilter: string;
  shouldSkipTransition?: boolean;
  onSearchQuery: (query: string) => void;
  onSelectSettings: () => void;
  onSelectContacts: () => void;
  onSelectArchived: () => void;
  onReset: () => void;
};

type StateProps =
  {
    searchQuery?: string;
    isLoading: boolean;
    currentUserId?: string;
    globalSearchChatId?: string;
    searchDate?: number;
    theme: ISettings['theme'];
    animationLevel: 0 | 1 | 2;
    chatsById?: Record<string, ApiChat>;
    isConnectionStatusMinimized: ISettings['isConnectionStatusMinimized'];
    isMessageListOpen: boolean;
  }
  & Pick<GlobalState, 'connectionState' | 'isSyncing'>;

const ANIMATION_LEVEL_OPTIONS = [0, 1, 2];

const PRODUCTION_HOSTNAME = 'web.telegram.org';
const LEGACY_VERSION_URL = 'https://web.telegram.org/?legacy=1';
const WEBK_VERSION_URL = 'https://web.telegram.org/k/';

const LeftMainHeader: FC<OwnProps & StateProps> = ({
  content,
  contactsFilter,
  onSearchQuery,
  onSelectSettings,
  onSelectContacts,
  onSelectArchived,
  onReset,
  searchQuery,
  isLoading,
  shouldSkipTransition,
  currentUserId,
  globalSearchChatId,
  searchDate,
  theme,
  animationLevel,
  chatsById,
  connectionState,
  isSyncing,
  isConnectionStatusMinimized,
  isMessageListOpen,
}) => {
  const {
    openChat,
    openTipsChat,
    setGlobalSearchDate,
    setSettingOption, setGlobalSearchChatId,
  } = getDispatch();

  const lang = useLang();
  const hasMenu = content === LeftColumnContent.ChatList;
  const clearedDateSearchParam = { date: undefined };
  const clearedChatSearchParam = { id: undefined };
  const selectedSearchDate = useMemo(() => {
    return searchDate
      ? formatDateToString(new Date(searchDate * 1000))
      : undefined;
  }, [searchDate]);
  const archivedUnreadChatsCount = useMemo(() => {
    if (!hasMenu || !chatsById) {
      return 0;
    }

    return Object.values(chatsById).reduce((total, chat) => {
      if (!isChatArchived(chat)) {
        return total;
      }

      return chat.unreadCount ? total + 1 : total;
    }, 0);
  }, [hasMenu, chatsById]);

  const { connectionStatus, connectionStatusText, connectionStatusPosition } = useConnectionStatus(
    lang, connectionState, isSyncing, isMessageListOpen, isConnectionStatusMinimized,
  );

  const withOtherVersions = window.location.hostname === PRODUCTION_HOSTNAME;

  const MainButton: FC<{ onTrigger: () => void; isOpen?: boolean }> = useMemo(() => {
    return ({ onTrigger, isOpen }) => (
      <Button
        round
        ripple={hasMenu && !IS_SINGLE_COLUMN_LAYOUT}
        size="smaller"
        color="translucent"
        className={isOpen ? 'active' : ''}
        onClick={hasMenu ? onTrigger : () => onReset()}
        ariaLabel={hasMenu ? lang('AccDescrOpenMenu2') : 'Return to chat list'}
      >
        <div className={buildClassName(
          'animated-menu-icon',
          !hasMenu && 'state-back',
          shouldSkipTransition && 'no-animation',
        )}
        />
      </Button>
    );
  }, [hasMenu, lang, onReset, shouldSkipTransition]);

  const handleSearchFocus = useCallback(() => {
    if (!searchQuery) {
      onSearchQuery('');
    }
  }, [searchQuery, onSearchQuery]);

  const toggleConnectionStatus = useCallback(() => {
    setSettingOption({ isConnectionStatusMinimized: !isConnectionStatusMinimized });
  }, [isConnectionStatusMinimized, setSettingOption]);

  const handleSelectSaved = useCallback(() => {
    openChat({ id: currentUserId, shouldReplaceHistory: true });
  }, [currentUserId, openChat]);

  const handleDarkModeToggle = useCallback((e: React.SyntheticEvent<HTMLElement>) => {
    e.stopPropagation();
    const newTheme = theme === 'light' ? 'dark' : 'light';

    setSettingOption({ theme: newTheme });
    setSettingOption({ shouldUseSystemTheme: false });
    switchTheme(newTheme, animationLevel === ANIMATION_LEVEL_MAX);
  }, [animationLevel, setSettingOption, theme]);

  const handleAnimationLevelChange = useCallback((e: React.SyntheticEvent<HTMLElement>) => {
    e.stopPropagation();

    const newLevel = animationLevel === 0 ? 2 : 0;
    ANIMATION_LEVEL_OPTIONS.forEach((_, i) => {
      document.body.classList.toggle(`animation-level-${i}`, newLevel === i);
    });

    setSettingOption({ animationLevel: newLevel });
  }, [animationLevel, setSettingOption]);

  const handleSwitchToWebK = () => {
    setPermanentWebVersion('K');
    clearWebsync();
    disableHistoryBack();
  };

  const handleOpenTipsChat = () => {
    openTipsChat({ langCode: lang.code });
  };

  const isSearchFocused = (
    Boolean(globalSearchChatId)
    || content === LeftColumnContent.GlobalSearch
    || content === LeftColumnContent.Contacts
  );

  const searchInputPlaceholder = content === LeftColumnContent.Contacts
    ? lang('SearchFriends')
    : lang('Search');

  return (
    <div className="LeftMainHeader">
      <div id="LeftMainHeader" className="left-header">
        <DropdownMenu
          trigger={MainButton}
          footer={`${APP_NAME} ${APP_VERSION}`}
        >
          <MenuItem
            icon="saved-messages"
            onClick={handleSelectSaved}
          >
            {lang('SavedMessages')}
          </MenuItem>
          <MenuItem
            icon="archive"
            onClick={onSelectArchived}
          >
            <span className="menu-item-name">{lang('ArchivedChats')}</span>
            {archivedUnreadChatsCount > 0 && (
              <div className="archived-badge">{archivedUnreadChatsCount}</div>
            )}
          </MenuItem>
          <MenuItem
            icon="user"
            onClick={onSelectContacts}
          >
            {lang('Contacts')}
          </MenuItem>
          <MenuItem
            icon="settings"
            onClick={onSelectSettings}
          >
            {lang('Settings')}
          </MenuItem>
          <MenuItem
            icon="darkmode"
            onClick={handleDarkModeToggle}
          >
            <span className="menu-item-name">{lang('lng_menu_night_mode')}</span>
            <Switcher
              id="darkmode"
              label={lang(theme === 'dark' ? 'lng_settings_disable_night_theme' : 'lng_settings_enable_night_theme')}
              checked={theme === 'dark'}
              noAnimation
            />
          </MenuItem>
          <MenuItem
            icon="animations"
            onClick={handleAnimationLevelChange}
          >
            <span className="menu-item-name capitalize">{lang('Appearance.Animations').toLowerCase()}</span>
            <Switcher
              id="animations"
              label="Toggle Animations"
              checked={animationLevel > 0}
            />
          </MenuItem>
          <MenuItem
            icon="help"
            onClick={handleOpenTipsChat}
          >
            {lang('TelegramFeatures')}
          </MenuItem>
          <MenuItem
            icon="bug"
            href={FEEDBACK_URL}
          >
            Report Bug
          </MenuItem>
          {withOtherVersions && (
            <>
              <MenuItem
                icon="char-K"
                href={WEBK_VERSION_URL}
                onClick={handleSwitchToWebK}
              >
                Switch to K Version
              </MenuItem>
              <MenuItem
                icon="char-W"
                href={LEGACY_VERSION_URL}
                onClick={disableHistoryBack}
              >
                Switch to Old Version
              </MenuItem>
            </>
          )}
        </DropdownMenu>
        <SearchInput
          inputId="telegram-search-input"
          parentContainerClassName="LeftSearch"
          className={globalSearchChatId || searchDate ? 'with-picker-item' : ''}
          value={contactsFilter || searchQuery}
          focused={isSearchFocused}
          isLoading={isLoading || connectionStatusPosition === 'minimized'}
          spinnerColor={connectionStatusPosition === 'minimized' ? 'yellow' : undefined}
          spinnerBackgroundColor={connectionStatusPosition === 'minimized' && theme === 'light' ? 'light' : undefined}
          placeholder={searchInputPlaceholder}
          autoComplete="off"
          canClose={Boolean(globalSearchChatId || searchDate)}
          onChange={onSearchQuery}
          onReset={onReset}
          onFocus={handleSearchFocus}
          onSpinnerClick={connectionStatusPosition === 'minimized' ? toggleConnectionStatus : undefined}
        >
          {selectedSearchDate && (
            <PickerSelectedItem
              icon="calendar"
              title={selectedSearchDate}
              canClose
              isMinimized={Boolean(globalSearchChatId)}
              className="search-date"
              onClick={setGlobalSearchDate}
              clickArg={clearedDateSearchParam}
            />
          )}
          {globalSearchChatId && (
            <PickerSelectedItem
              chatOrUserId={globalSearchChatId}
              onClick={setGlobalSearchChatId}
              canClose
              clickArg={clearedChatSearchParam}
            />
          )}
        </SearchInput>
        <ShowTransition
          isOpen={connectionStatusPosition === 'overlay'}
          isCustom
          className="connection-state-wrapper"
        >
          {() => (
            <ConnectionStatusOverlay
              connectionStatus={connectionStatus}
              connectionStatusText={connectionStatusText!}
              onClick={toggleConnectionStatus}
            />
          )}
        </ShowTransition>
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): StateProps => {
    const {
      query: searchQuery, fetchingStatus, chatId, date,
    } = global.globalSearch;
    const { currentUserId, connectionState, isSyncing } = global;
    const { byId: chatsById } = global.chats;
    const { isConnectionStatusMinimized, animationLevel } = global.settings.byKey;

    return {
      searchQuery,
      isLoading: fetchingStatus ? Boolean(fetchingStatus.chats || fetchingStatus.messages) : false,
      currentUserId,
      chatsById,
      globalSearchChatId: chatId,
      searchDate: date,
      theme: selectTheme(global),
      animationLevel,
      connectionState,
      isSyncing,
      isConnectionStatusMinimized,
      isMessageListOpen: Boolean(selectCurrentMessageList(global)),
    };
  },
)(LeftMainHeader));
