import { addCallback, getGlobal } from '../lib/teact/teactn';

import { GlobalState } from '../global/types';
import { NotifyException, NotifySettings } from '../types';
import { ApiChat, ApiChatFolder, ApiUser } from '../api/types';

import { ALL_FOLDER_ID, ARCHIVED_FOLDER_ID, DEBUG } from '../config';
import { selectNotifySettings, selectNotifyExceptions } from '../modules/selectors';
import { selectIsChatMuted } from '../modules/helpers';
import { onIdle, throttle } from './schedulers';
import { areSortedArraysEqual, unique } from './iteratees';
import arePropsShallowEqual from './arePropsShallowEqual';
import { CallbackManager, createCallbackManager } from './callbacks';

interface FolderSummary {
  id: number;
  listIds?: Set<string>;
  orderedPinnedIds?: string[];
  contacts?: true;
  nonContacts?: true;
  groups?: true;
  channels?: true;
  bots?: true;
  excludeMuted?: true;
  excludeRead?: true;
  excludeArchived?: true;
  excludedChatIds?: Set<string>;
  includedChatIds?: Set<string>;
  pinnedChatIds?: Set<string>;
}

interface ChatSummary {
  id: string;
  type: ApiChat['type'];
  isListed: boolean;
  isArchived: boolean;
  isMuted: boolean;
  isUnread: boolean;
  unreadCount?: number;
  unreadMentionsCount?: number;
  order: number;
  isUserBot?: boolean;
  isUserContact?: boolean;
}

const UPDATE_THROTTLE = 500;
const DEBUG_DURATION_LIMIT = 6;

const prevGlobal: {
  allFolderListIds?: GlobalState['chats']['listIds']['active'];
  allFolderPinnedIds?: GlobalState['chats']['orderedPinnedIds']['active'];
  archivedFolderListIds?: GlobalState['chats']['listIds']['archived'];
  archivedFolderPinnedIds?: GlobalState['chats']['orderedPinnedIds']['archived'];
  chatsById: Record<string, ApiChat>;
  foldersById: Record<string, ApiChatFolder>;
  usersById: Record<string, ApiUser>;
  notifySettings: NotifySettings;
  notifyExceptions?: Record<number, NotifyException>;
} = {
  foldersById: {},
  chatsById: {},
  usersById: {},
  notifySettings: {} as NotifySettings,
  notifyExceptions: {},
};

const prepared: {
  folderSummariesById: Record<string, FolderSummary>;
  chatSummariesById: Map<string, ChatSummary>;
  folderIdsByChatId: Record<string, number[]>;
  chatIdsByFolderId: Record<number, Set<string>>;
  isOrderedListJustPatched: Record<number, boolean | undefined>;
} = {
  folderSummariesById: {},
  chatSummariesById: new Map(),
  folderIdsByChatId: {},
  chatIdsByFolderId: {},
  isOrderedListJustPatched: {},
};

const results: {
  orderedIdsByFolderId: Record<string, string[] | undefined>;
  chatsCountByFolderId: Record<string, number | undefined>;
  unreadCountersByFolderId: Record<string, {
    chatsCount: number;
    notificationsCount: number;
  } | undefined>;
} = {
  orderedIdsByFolderId: {},
  chatsCountByFolderId: {},
  unreadCountersByFolderId: {},
};

const callbacks: {
  orderedIdsByFolderId: Record<number, CallbackManager>;
  chatsCountByFolderId: CallbackManager;
  unreadCountersByFolderId: CallbackManager;
} = {
  orderedIdsByFolderId: {},
  chatsCountByFolderId: createCallbackManager(),
  unreadCountersByFolderId: createCallbackManager(),
};

const updateFolderManagerThrottled = throttle(() => {
  onIdle(() => {
    updateFolderManager(getGlobal());
  });
}, UPDATE_THROTTLE);

let inited = false;

function init() {
  addCallback(updateFolderManagerThrottled);
  updateFolderManager(getGlobal());
}

/* Getters */

export function getOrderedIds(folderId: number) {
  if (!inited) init();

  return results.orderedIdsByFolderId[folderId];
}

export function getChatsCount() {
  if (!inited) init();

  return results.chatsCountByFolderId;
}

export function getUnreadCounters() {
  if (!inited) init();

  return results.unreadCountersByFolderId;
}

export function getAllNotificationsCount() {
  return getUnreadCounters()[ALL_FOLDER_ID]?.notificationsCount || 0;
}

export function getPinnedChatsCount(folderId: number) {
  return prepared.folderSummariesById[folderId]?.pinnedChatIds?.size;
}

/* Callback managers */

export function addOrderedIdsCallback(folderId: number, callback: (orderedIds: string[]) => void) {
  if (!callbacks.orderedIdsByFolderId[folderId]) {
    callbacks.orderedIdsByFolderId[folderId] = createCallbackManager();
  }

  return callbacks.orderedIdsByFolderId[folderId].addCallback(callback);
}

export function addChatsCountCallback(callback: (chatsCount: typeof results.chatsCountByFolderId) => void) {
  return callbacks.chatsCountByFolderId.addCallback(callback);
}

export function addUnreadCountersCallback(callback: (unreadCounters: typeof results.unreadCountersByFolderId) => void) {
  return callbacks.unreadCountersByFolderId.addCallback(callback);
}

/* Global update handlers */

function updateFolderManager(global: GlobalState) {
  // eslint-disable-next-line @typescript-eslint/naming-convention
  let DEBUG_startedAt: number;
  if (DEBUG) {
    DEBUG_startedAt = performance.now();
  }

  const isAllFolderChanged = Boolean(
    global.chats.listIds.active
    && isMainFolderChanged(ALL_FOLDER_ID, global.chats.listIds.active, global.chats.orderedPinnedIds.active),
  );
  const isArchivedFolderChanged = Boolean(
    global.chats.listIds.archived
    && isMainFolderChanged(ARCHIVED_FOLDER_ID, global.chats.listIds.archived, global.chats.orderedPinnedIds.archived),
  );

  const areFoldersChanged = global.chatFolders.byId !== prevGlobal.foldersById;
  const areChatsChanged = global.chats.byId !== prevGlobal.chatsById;
  const areUsersChanged = global.users.byId !== prevGlobal.usersById;
  const areNotifySettingsChanged = selectNotifySettings(global) !== prevGlobal.notifySettings;
  const areNotifyExceptionsChanged = selectNotifyExceptions(global) !== prevGlobal.notifyExceptions;

  if (!(
    isAllFolderChanged || isArchivedFolderChanged || areFoldersChanged
    || areChatsChanged || areUsersChanged || areNotifySettingsChanged || areNotifyExceptionsChanged
  )
  ) {
    return;
  }

  const prevAllFolderListIds = prevGlobal.allFolderListIds;
  const prevArchivedFolderListIds = prevGlobal.archivedFolderListIds;

  updateFolders(global, isAllFolderChanged, isArchivedFolderChanged, areFoldersChanged);

  const affectedFolderIds = updateChats(
    global, areFoldersChanged, areNotifySettingsChanged, areNotifyExceptionsChanged,
    prevAllFolderListIds, prevArchivedFolderListIds,
  );

  updateResults(affectedFolderIds);

  if (DEBUG) {
    const duration = performance.now() - DEBUG_startedAt!;
    if (duration > DEBUG_DURATION_LIMIT) {
      // eslint-disable-next-line no-console
      console.warn(`Slow \`updateFolderManager\`: ${Math.round(duration)} ms`);
    }
  }
}

function isMainFolderChanged(folderId: number, newListIds?: string[], newPinnedIds?: string[]) {
  const currentListIds = folderId === ALL_FOLDER_ID
    ? prevGlobal.allFolderListIds
    : prevGlobal.archivedFolderListIds;
  const currentPinnedIds = folderId === ALL_FOLDER_ID
    ? prevGlobal.allFolderPinnedIds
    : prevGlobal.archivedFolderPinnedIds;

  return currentListIds !== newListIds || currentPinnedIds !== newPinnedIds;
}

function updateFolders(
  global: GlobalState, isAllFolderChanged: boolean, isArchivedFolderChanged: boolean, areFoldersChanged: boolean,
) {
  const changedFolders = [];

  if (isAllFolderChanged) {
    const newListIds = global.chats.listIds.active!;
    const newPinnedIds = global.chats.orderedPinnedIds.active;

    prepared.folderSummariesById[ALL_FOLDER_ID] = buildFolderSummaryFromMainList(
      ALL_FOLDER_ID, newListIds, newPinnedIds,
    );

    prevGlobal.allFolderListIds = newListIds;
    prevGlobal.allFolderPinnedIds = newPinnedIds;

    changedFolders.push(ALL_FOLDER_ID);
  }

  if (isArchivedFolderChanged) {
    const newListIds = global.chats.listIds.archived!;
    const newPinnedIds = global.chats.orderedPinnedIds.archived;

    prepared.folderSummariesById[ARCHIVED_FOLDER_ID] = buildFolderSummaryFromMainList(
      ARCHIVED_FOLDER_ID, newListIds, newPinnedIds,
    );

    prevGlobal.archivedFolderListIds = newListIds;
    prevGlobal.archivedFolderPinnedIds = newPinnedIds;

    changedFolders.push(ARCHIVED_FOLDER_ID);
  }

  if (areFoldersChanged) {
    const newFoldersById = global.chatFolders.byId;

    Object.values(newFoldersById).forEach((folder) => {
      if (folder === prevGlobal.foldersById[folder.id]) {
        return;
      }

      prepared.folderSummariesById[folder.id] = buildFolderSummary(folder);

      changedFolders.push(folder.id);
    });

    prevGlobal.foldersById = newFoldersById;
  }

  return changedFolders;
}

function buildFolderSummaryFromMainList(
  folderId: number, listIds: string[], orderedPinnedIds?: string[],
): FolderSummary {
  return {
    id: folderId,
    listIds: new Set(listIds),
    orderedPinnedIds: orderedPinnedIds,
    pinnedChatIds: new Set(orderedPinnedIds),
  };
}

function buildFolderSummary(folder: ApiChatFolder): FolderSummary {
  return {
    ...folder,
    orderedPinnedIds: folder.pinnedChatIds,
    excludedChatIds: folder.excludedChatIds ? new Set(folder.excludedChatIds) : undefined,
    includedChatIds: folder.excludedChatIds ? new Set(folder.includedChatIds) : undefined,
    pinnedChatIds: folder.excludedChatIds ? new Set(folder.pinnedChatIds) : undefined,
  };
}

function updateChats(
  global: GlobalState,
  areFoldersChanged: boolean,
  areNotifySettingsChanged: boolean,
  areNotifyExceptionsChanged: boolean,
  prevAllFolderListIds?: string[],
  prevArchivedFolderListIds?: string[],
) {
  const newChatsById = global.chats.byId;
  const newUsersById = global.users.byId;
  const newNotifySettings = selectNotifySettings(global);
  const newNotifyExceptions = selectNotifyExceptions(global);
  const folderSummaries = Object.values(prepared.folderSummariesById);
  const affectedFolderIds = new Set<number>();

  const newAllFolderListIds = global.chats.listIds.active;
  const newArchivedFolderListIds = global.chats.listIds.archived;
  let allIds = [...newAllFolderListIds || [], ...newArchivedFolderListIds || []];
  if (newAllFolderListIds !== prevAllFolderListIds || newArchivedFolderListIds !== prevArchivedFolderListIds) {
    allIds = unique(allIds.concat(prevAllFolderListIds || [], prevArchivedFolderListIds || []));
  }

  allIds.forEach((chatId) => {
    const chat = newChatsById[chatId];

    if (
      !areFoldersChanged
      && !areNotifySettingsChanged
      && !areNotifyExceptionsChanged
      && chat === prevGlobal.chatsById[chatId]
      && newUsersById[chatId] === prevGlobal.usersById[chatId]
    ) {
      return;
    }

    let newFolderIds: number[];
    if (chat) {
      const currentSummary = prepared.chatSummariesById.get(chatId);
      const newSummary = buildChatSummary(chat, newNotifySettings, newNotifyExceptions, newUsersById[chatId]);
      if (!areFoldersChanged && currentSummary && arePropsShallowEqual(newSummary, currentSummary)) {
        return;
      }

      prepared.chatSummariesById.set(chatId, newSummary);

      newFolderIds = buildChatFolderIds(newSummary, folderSummaries);
      newFolderIds.forEach((folderId) => {
        affectedFolderIds.add(folderId);
      });
    } else {
      prepared.chatSummariesById.delete(chatId);
      newFolderIds = [];
    }

    const currentFolderIds = prepared.folderIdsByChatId[chatId] || [];
    if (areSortedArraysEqual(newFolderIds, currentFolderIds)) {
      return;
    }

    const deletedFolderIds = updateListsForChat(chatId, currentFolderIds, newFolderIds);
    deletedFolderIds.forEach((folderId) => {
      affectedFolderIds.add(folderId);
    });
  });

  prevGlobal.chatsById = newChatsById;
  prevGlobal.usersById = newUsersById;
  prevGlobal.notifySettings = newNotifySettings;
  prevGlobal.notifyExceptions = newNotifyExceptions;

  return Array.from(affectedFolderIds);
}

function buildChatSummary(
  chat: ApiChat,
  notifySettings: NotifySettings,
  notifyExceptions?: Record<number, NotifyException>,
  user?: ApiUser,
): ChatSummary {
  const {
    id, type, lastMessage, isRestricted, isNotJoined, folderId,
    unreadCount, unreadMentionsCount, hasUnreadMark,
    joinDate, draftDate,
  } = chat;

  const userInfo = type === 'chatTypePrivate' && user;

  return {
    id,
    type,
    isListed: Boolean(lastMessage && !isRestricted && !isNotJoined),
    isArchived: folderId === ARCHIVED_FOLDER_ID,
    isMuted: selectIsChatMuted(chat, notifySettings, notifyExceptions),
    isUnread: Boolean(unreadCount || unreadMentionsCount || hasUnreadMark),
    unreadCount,
    unreadMentionsCount,
    order: Math.max(joinDate || 0, draftDate || 0, lastMessage?.date || 0),
    isUserBot: userInfo ? userInfo.type === 'userTypeBot' : undefined,
    isUserContact: userInfo ? userInfo.isContact : undefined,
  };
}

function buildChatFolderIds(chatSummary: ChatSummary, folderSummaries: FolderSummary[]) {
  return folderSummaries.reduce<number[]>((acc, folderSummary) => {
    if (isChatInFolder(chatSummary, folderSummary)) {
      acc.push(folderSummary.id);
    }

    return acc;
  }, []).sort();
}

function isChatInFolder(
  chatSummary: ChatSummary,
  folderSummary: FolderSummary,
) {
  if (!chatSummary.isListed) {
    return false;
  }

  const { id: chatId, type } = chatSummary;

  if (folderSummary.listIds) {
    if (
      (chatSummary.isArchived && folderSummary.id === ALL_FOLDER_ID)
      || (!chatSummary.isArchived && folderSummary.id === ARCHIVED_FOLDER_ID)
    ) {
      return false;
    }

    return folderSummary.listIds.has(chatId);
  }

  if (folderSummary.excludedChatIds?.has(chatId)) {
    return false;
  }

  if (folderSummary.includedChatIds?.has(chatId)) {
    return true;
  }

  if (folderSummary.pinnedChatIds?.has(chatId)) {
    return true;
  }

  if (folderSummary.excludeArchived && chatSummary.isArchived) {
    return false;
  }

  if (folderSummary.excludeRead && !chatSummary.isUnread) {
    return false;
  }

  if (folderSummary.excludeMuted && chatSummary.isMuted && !chatSummary.unreadMentionsCount) {
    return false;
  }

  if (type === 'chatTypePrivate') {
    if (chatSummary.isUserBot) {
      if (folderSummary.bots) {
        return true;
      }
    } else {
      if (folderSummary.contacts && chatSummary.isUserContact) {
        return true;
      }

      if (folderSummary.nonContacts && !chatSummary.isUserContact) {
        return true;
      }
    }
  } else if (type === 'chatTypeChannel') {
    return Boolean(folderSummary.channels);
  } else if (type === 'chatTypeBasicGroup' || type === 'chatTypeSuperGroup') {
    return Boolean(folderSummary.groups);
  }

  return false;
}

function updateListsForChat(chatId: string, currentFolderIds: number[], newFolderIds: number[]) {
  const currentFolderIdsSet = new Set(currentFolderIds);
  const newFolderIdsSet = new Set(newFolderIds);
  const deletedFolderIds: number[] = [];

  unique([...currentFolderIds, ...newFolderIds]).forEach((folderId) => {
    let currentFolderOrderedIds = results.orderedIdsByFolderId[folderId];

    if (currentFolderIdsSet.has(folderId) && !newFolderIdsSet.has(folderId)) {
      prepared.chatIdsByFolderId[folderId].delete(chatId);

      deletedFolderIds.push(folderId);

      if (currentFolderOrderedIds) {
        currentFolderOrderedIds = currentFolderOrderedIds.filter((id) => id !== chatId);
        prepared.isOrderedListJustPatched[folderId] = true;
      }
    } else if (!currentFolderIdsSet.has(folderId) && newFolderIdsSet.has(folderId)) {
      if (!prepared.chatIdsByFolderId[folderId]) {
        prepared.chatIdsByFolderId[folderId] = new Set();
      }

      prepared.chatIdsByFolderId[folderId].add(chatId);

      if (currentFolderOrderedIds) {
        currentFolderOrderedIds.push(chatId);
        prepared.isOrderedListJustPatched[folderId] = true;
      }
    }

    results.orderedIdsByFolderId[folderId] = currentFolderOrderedIds;
  });

  prepared.folderIdsByChatId[chatId] = newFolderIds;

  return deletedFolderIds;
}

function updateResults(affectedFolderIds: number[]) {
  let wasUnreadCountersChanged = false;
  let wasChatsCountChanged = false;

  Array.from(affectedFolderIds).forEach((folderId) => {
    const newOrderedIds = buildFolderOrderedIds(folderId);

    const currentOrderedIds = results.orderedIdsByFolderId[folderId];
    const areOrderedIdsChanged = (
      !currentOrderedIds
      || prepared.isOrderedListJustPatched[folderId]
      || !areSortedArraysEqual(newOrderedIds, currentOrderedIds)
    );
    if (areOrderedIdsChanged) {
      prepared.isOrderedListJustPatched[folderId] = false;
      results.orderedIdsByFolderId[folderId] = newOrderedIds;
      callbacks.orderedIdsByFolderId[folderId]?.runCallbacks(newOrderedIds);
    }

    const currentChatsCount = results.chatsCountByFolderId[folderId];
    const newChatsCount = newOrderedIds.length;
    if (!wasChatsCountChanged) {
      wasChatsCountChanged = currentChatsCount !== newChatsCount;
    }
    results.chatsCountByFolderId[folderId] = newChatsCount;

    const currentUnreadCounters = results.unreadCountersByFolderId[folderId];
    const newUnreadCounters = buildFolderUnreadCounters(folderId);
    if (!wasUnreadCountersChanged) {
      wasUnreadCountersChanged = (
        !currentUnreadCounters || !arePropsShallowEqual(newUnreadCounters, currentUnreadCounters)
      );
    }
    results.unreadCountersByFolderId[folderId] = newUnreadCounters;
  });

  if (wasChatsCountChanged) {
    // We need to update the entire object as it will be returned from a hook
    const newValue = { ...results.chatsCountByFolderId };
    results.chatsCountByFolderId = newValue;
    callbacks.chatsCountByFolderId.runCallbacks(newValue);
  }

  if (wasUnreadCountersChanged) {
    // We need to update the entire object as it will be returned from a hook
    const newValue = { ...results.unreadCountersByFolderId };
    results.unreadCountersByFolderId = newValue;
    callbacks.unreadCountersByFolderId.runCallbacks(newValue);
  }
}

function buildFolderOrderedIds(folderId: number) {
  const {
    folderSummariesById: { [folderId]: { orderedPinnedIds, pinnedChatIds } },
    chatSummariesById,
    chatIdsByFolderId: { [folderId]: chatIds },
  } = prepared;
  const {
    orderedIdsByFolderId: { [folderId]: prevOrderedIds },
  } = results;

  const allListIds = prevOrderedIds || Array.from(chatIds);
  const notPinnedIds = pinnedChatIds ? allListIds.filter((id) => !pinnedChatIds.has(id)) : allListIds;
  const sortedNotPinnedIds = notPinnedIds.sort((chatId1: string, chatId2: string) => {
    return chatSummariesById.get(chatId2)!.order - chatSummariesById.get(chatId1)!.order;
  });

  return [
    ...(orderedPinnedIds || []),
    ...sortedNotPinnedIds,
  ];
}

function buildFolderUnreadCounters(folderId: number) {
  const {
    chatSummariesById,
  } = prepared;
  const {
    orderedIdsByFolderId: { [folderId]: orderedIds },
  } = results;

  return orderedIds!.reduce((newUnreadCounters, chatId) => {
    const chatSummary = chatSummariesById.get(chatId);
    if (!chatSummary) {
      return newUnreadCounters;
    }

    if (chatSummary.isUnread) {
      newUnreadCounters.chatsCount++;

      if (chatSummary.unreadMentionsCount) {
        newUnreadCounters.notificationsCount += chatSummary.unreadMentionsCount;
      }

      if (!chatSummary.isMuted) {
        if (chatSummary.unreadCount) {
          newUnreadCounters.notificationsCount += chatSummary.unreadCount;
        } else if (!chatSummary.unreadMentionsCount) {
          newUnreadCounters.notificationsCount += 1; // Manually marked unread
        }
      }
    }

    return newUnreadCounters;
  }, {
    chatsCount: 0,
    notificationsCount: 0,
  });
}
