//
// Copyright © 2024 Hardcore Engineering Inc.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//
import { createQuery, getClient } from '@hcengineering/presentation'
import {
  type Account,
  type Class,
  type Doc,
  type DocumentQuery,
  getCurrentAccount,
  isOtherDay,
  type Ref,
  SortingOrder,
  type Timestamp
} from '@hcengineering/core'

import { derived, get, type Readable, writable } from 'svelte/store'
import { type ActivityMessage } from '@hcengineering/activity'
import attachment from '@hcengineering/attachment'
import { combineActivityMessages } from '@hcengineering/activity-resources'
import { type ChatMessage } from '@hcengineering/chunter'
import notification, { type DocNotifyContext } from '@hcengineering/notification'

import chunter from './plugin'

export type LoadMode = 'forward' | 'backward'

export interface MessageMetadata {
  _id: Ref<ActivityMessage>
  _class: Ref<Class<ActivityMessage>>
  createdOn?: Timestamp
  modifiedOn: Timestamp
  createdBy?: Ref<Account>
}

interface Chunk {
  from: Timestamp
  to: Timestamp
  data: ActivityMessage[]
}

interface IChannelDataProvider {
  limit: number

  isLoadingStore: Readable<boolean>
  isLoadingMoreStore: Readable<boolean>
  messagesStore: Readable<ActivityMessage[]>
  newTimestampStore: Readable<Timestamp | undefined>
  datesStore: Readable<Timestamp[]>
  metadataStore: Readable<MessageMetadata[]>

  canLoadMore: (mode: LoadMode, loadAfter: Timestamp) => boolean
  jumpToDate: (date: Timestamp) => Promise<void>
}

export class ChannelDataProvider implements IChannelDataProvider {
  public readonly limit = 50

  private readonly metadataQuery = createQuery(true)
  private readonly tailQuery = createQuery(true)

  private chatId: Ref<Doc> | undefined = undefined
  private readonly context: DocNotifyContext | undefined = undefined
  private readonly msgClass: Ref<Class<ActivityMessage>>
  private selectedMsgId: Ref<ActivityMessage> | undefined = undefined
  private tailStart: Timestamp | undefined = undefined

  public readonly metadataStore = writable<MessageMetadata[]>([])
  private readonly tailStore = writable<ActivityMessage[]>([])
  private readonly chunksStore = writable<Chunk[]>([])

  private readonly isInitialLoadingStore = writable(false)
  private readonly isInitialLoadedStore = writable(false)
  private readonly isTailLoading = writable(false)

  readonly isTailLoaded = writable(false)

  public datesStore = writable<Timestamp[]>([])
  public newTimestampStore = writable<Timestamp | undefined>(undefined)

  public isLoadingMoreStore = writable(false)

  public isLoadingStore = derived(
    [this.isInitialLoadedStore, this.isTailLoading],
    ([initialLoaded, tailLoading]) => !initialLoaded || tailLoading
  )

  private readonly backwardNextStore = writable<Chunk | undefined>(undefined)
  private readonly forwardNextStore = writable<Chunk | undefined>(undefined)

  private backwardNextPromise: Promise<void> | undefined = undefined
  private forwardNextPromise: Promise<void> | undefined = undefined

  private readonly isBackwardLoading = writable(false)
  private readonly isForwardLoading = writable(false)

  private nextChunkAdding = false

  public messagesStore = derived([this.chunksStore, this.tailStore], ([chunks, tail]) => {
    return [...chunks.map(({ data }) => data).flat(), ...tail]
  })

  public canLoadNextForwardStore = derived([this.messagesStore, this.forwardNextStore], ([messages, forwardNext]) => {
    if (forwardNext !== undefined) return false

    return this.canLoadMore('forward', messages[messages.length - 1]?.createdOn)
  })

  constructor (
    chatId: Ref<Doc>,
    _class: Ref<Class<ActivityMessage>>,
    context: DocNotifyContext | undefined,
    selectedMsgId?: Ref<ActivityMessage>,
    loadAll = false
  ) {
    this.chatId = chatId
    this.context = context
    this.msgClass = _class
    this.selectedMsgId = selectedMsgId
    void this.loadData(loadAll)
  }

  public destroy (): void {
    this.clearData()
    this.metadataQuery.unsubscribe()
    this.tailQuery.unsubscribe()
  }

  public canLoadMore (mode: LoadMode, timestamp?: Timestamp): boolean {
    if (timestamp === undefined) {
      return false
    }

    const metadata = get(this.metadataStore)

    if (mode === 'forward') {
      const isTailLoading = get(this.isTailLoading)
      const tail = get(this.tailStore)
      const last = metadata[metadata.length - 1]?.createdOn ?? 0
      return last > timestamp && !isTailLoading && tail.length === 0
    } else {
      const first = metadata[0]?.createdOn ?? 0
      return first < timestamp
    }
  }

  private clearData (): void {
    this.metadataStore.set([])
    this.isInitialLoadingStore.set(false)
    this.isTailLoading.set(false)
    this.datesStore.set([])
    this.newTimestampStore.set(undefined)
    this.isLoadingMoreStore.set(false)
    this.chatId = undefined
    this.selectedMsgId = undefined

    this.clearMessages()
  }

  private async loadData (loadAll = false): Promise<void> {
    if (this.chatId === undefined) {
      return
    }

    this.metadataQuery.query(
      this.msgClass,
      { attachedTo: this.chatId },
      (res) => {
        this.updatesDates(res)
        this.metadataStore.set(res)
        void this.loadInitialMessages(undefined, loadAll)
      },
      {
        projection: { _id: 1, _class: 1, createdOn: 1, createdBy: 1, attachedTo: 1, modifiedOn: 1 },
        sort: { createdOn: SortingOrder.Ascending }
      }
    )
  }

  private async loadInitialMessages (
    selectedMsg?: Ref<ActivityMessage>,
    loadAll = false,
    ignoreNew = false
  ): Promise<void> {
    const isLoading = get(this.isInitialLoadingStore)
    const isLoaded = get(this.isInitialLoadedStore)

    if (isLoading || isLoaded) {
      return
    }

    this.isInitialLoadingStore.set(true)

    const metadata = get(this.metadataStore)
    const firstNewMsgIndex = ignoreNew ? undefined : await this.getFirstNewMsgIndex()

    if (get(this.newTimestampStore) === undefined) {
      this.newTimestampStore.set(firstNewMsgIndex !== undefined ? metadata[firstNewMsgIndex]?.createdOn : undefined)
    } else if (ignoreNew) {
      this.newTimestampStore.set(undefined)
    }

    const startPosition = this.getStartPosition(selectedMsg ?? this.selectedMsgId, firstNewMsgIndex)

    const count = metadata.length
    const isLoadingLatest = startPosition === undefined || startPosition === -1 || count - startPosition <= this.limit

    if (loadAll) {
      this.isTailLoading.set(true)
      this.loadTail(undefined, combineActivityMessages)
    } else if (isLoadingLatest) {
      const startIndex = Math.max(0, count - this.limit)
      this.isTailLoading.set(true)
      const tailStart = metadata[startIndex]?.createdOn
      this.loadTail(tailStart)
      this.backwardNextPromise = this.loadNext('backward', metadata[startIndex]?.createdOn, this.limit)
    } else {
      const newStart = Math.max(startPosition - this.limit / 2, 0)
      await this.loadMore('forward', metadata[newStart]?.createdOn, this.limit)
      if (newStart > 0) {
        this.backwardNextPromise = this.loadNext('backward', metadata[newStart]?.createdOn, this.limit)
      }
    }

    this.isInitialLoadingStore.set(false)
    this.isInitialLoadedStore.set(true)
  }

  private loadTail (
    start?: Timestamp,
    afterLoad?: (msgs: ActivityMessage[]) => Promise<ActivityMessage[]>,
    query?: DocumentQuery<ActivityMessage>
  ): void {
    if (this.chatId === undefined) {
      this.isTailLoading.set(false)
      return
    }

    if (this.tailStart === undefined) {
      this.tailStart = start
    }

    this.tailQuery.query(
      this.msgClass,
      {
        attachedTo: this.chatId,
        ...query,
        ...(this.tailStart !== undefined ? { createdOn: { $gte: this.tailStart } } : {})
      },
      async (res) => {
        if (afterLoad !== undefined) {
          const result = await afterLoad(res.reverse())
          this.tailStore.set(result)
        } else {
          this.tailStore.set(res.reverse())
        }

        this.isTailLoaded.set(true)
        this.isTailLoading.set(false)
      },
      {
        sort: { createdOn: SortingOrder.Descending },
        lookup: {
          _id: { attachments: attachment.class.Attachment }
        }
      }
    )
  }

  isNextLoading (mode: LoadMode): boolean {
    return mode === 'forward' ? get(this.isForwardLoading) : get(this.isBackwardLoading)
  }

  isNextLoaded (mode: LoadMode): boolean {
    return mode === 'forward' ? get(this.forwardNextStore) !== undefined : get(this.backwardNextStore) !== undefined
  }

  setNextLoading (mode: LoadMode, value: boolean): void {
    mode === 'forward' ? this.isForwardLoading.set(value) : this.isBackwardLoading.set(value)
  }

  getTailStartIndex (metadata: MessageMetadata[], loadAfter: Timestamp): number {
    const index = metadata.slice(-this.limit - 1).findIndex(({ createdOn }) => createdOn === loadAfter)

    return index !== -1 ? metadata.length - index : -1
  }

  async loadChunk (isBackward: boolean, loadAfter: Timestamp, limit?: number): Promise<Chunk | undefined> {
    const client = getClient()
    const skipIds = this.getChunkSkipIds(loadAfter)

    const messages = await client.findAll(
      chunter.class.ChatMessage,
      {
        attachedTo: this.chatId,
        _id: { $nin: skipIds },
        createdOn: isBackward ? { $lte: loadAfter } : { $gte: loadAfter }
      },
      {
        limit: limit ?? this.limit,
        sort: { createdOn: isBackward ? SortingOrder.Descending : SortingOrder.Ascending },
        lookup: {
          _id: { attachments: attachment.class.Attachment }
        }
      }
    )

    if (messages.length === 0) {
      return
    }

    const from = isBackward ? messages[0] : messages[messages.length - 1]
    const to = isBackward ? messages[messages.length - 1] : messages[0]

    return {
      from: from.createdOn ?? from.modifiedOn,
      to: to.createdOn ?? to.modifiedOn,
      data: isBackward ? messages.reverse() : messages
    }
  }

  getChunkSkipIds (after: Timestamp, loadTail = false): Array<Ref<ChatMessage>> {
    const chunks = get(this.chunksStore)
    const metadata = get(this.metadataStore)
    const tail = get(this.tailStore)
    const tailData = tail.length > 0 ? get(this.tailStore) : metadata.slice(-this.limit)

    return chunks
      .filter(({ to, from }) => from >= after || to <= after)
      .map(({ data }) => data as MessageMetadata[])
      .flat()
      .concat(loadTail ? [] : tailData)
      .filter(({ createdOn }) => createdOn === after)
      .map(({ _id }) => _id) as Array<Ref<ChatMessage>>
  }

  async loadNext (mode: LoadMode, loadAfter?: Timestamp, limit?: number): Promise<void> {
    if (this.chatId === undefined || loadAfter === undefined) {
      return
    }

    if (this.isNextLoading(mode) || this.isNextLoaded(mode)) {
      return
    }

    if (!this.canLoadMore(mode, loadAfter)) {
      return
    }

    this.setNextLoading(mode, true)

    const isBackward = mode === 'backward'
    const isForward = mode === 'forward'

    const metadata = get(this.metadataStore)

    if (isForward && this.getTailStartIndex(metadata, loadAfter) !== -1) {
      this.setNextLoading(mode, false)
      return
    }

    const chunk = await this.loadChunk(isBackward, loadAfter, limit)

    if (chunk !== undefined && isBackward) {
      this.backwardNextStore.set(chunk)
    }
    if (chunk !== undefined && isForward) {
      this.forwardNextStore.set(chunk)
    }

    this.setNextLoading(mode, false)
  }

  public async addNextChunk (mode: LoadMode, loadAfter?: Timestamp, limit?: number): Promise<void> {
    if (loadAfter === undefined || this.nextChunkAdding) {
      return
    }

    this.nextChunkAdding = true

    if (this.forwardNextPromise instanceof Promise && mode === 'forward') {
      await this.forwardNextPromise
      this.forwardNextPromise = undefined
    }

    if (this.backwardNextPromise instanceof Promise && mode === 'backward') {
      await this.backwardNextPromise
      this.backwardNextPromise = undefined
    }

    if (this.isNextLoaded(mode)) {
      const next = mode === 'forward' ? get(this.forwardNextStore) : get(this.backwardNextStore)
      if (next !== undefined) {
        if (mode === 'forward') {
          this.forwardNextStore.set(undefined)
          this.chunksStore.set([...get(this.chunksStore), next])
          this.forwardNextPromise = this.loadNext('forward', next.from, limit)
        } else {
          this.backwardNextStore.set(undefined)
          this.chunksStore.set([next, ...get(this.chunksStore)])
          this.backwardNextPromise = this.loadNext('backward', next.to, limit)
        }
      }
    } else {
      await this.loadMore(mode, loadAfter, limit)
    }

    this.nextChunkAdding = false
  }

  private async loadMore (mode: LoadMode, loadAfter?: Timestamp, limit?: number): Promise<void> {
    if (get(this.isLoadingMoreStore) || loadAfter === undefined) {
      return
    }

    if (!this.canLoadMore(mode, loadAfter)) {
      return
    }

    this.isLoadingMoreStore.set(true)

    const isBackward = mode === 'backward'
    const isForward = mode === 'forward'

    const chunks = get(this.chunksStore)
    const metadata = get(this.metadataStore)

    if (isForward) {
      const index = this.getTailStartIndex(metadata, loadAfter)
      const tailAfter = metadata[index]?.createdOn

      if (tailAfter !== undefined) {
        const skipIds = chunks[chunks.length - 1]?.data.map(({ _id }) => _id) ?? []
        this.loadTail(tailAfter, undefined, { _id: { $nin: skipIds } })
        this.isLoadingMoreStore.set(false)
        return
      }
    }

    const chunk = await this.loadChunk(isBackward, loadAfter, limit)

    if (chunk !== undefined) {
      this.chunksStore.set(isBackward ? [chunk, ...chunks] : [...chunks, chunk])

      if (isBackward) {
        this.forwardNextPromise = this.loadNext('backward', chunk.to, limit)
      } else {
        this.forwardNextPromise = this.loadNext('forward', chunk.from, limit)
      }
    }

    this.isLoadingMoreStore.set(false)
  }

  private getStartPosition (selectedMsgId?: Ref<ActivityMessage>, firsNewMsgIndex?: number): number | undefined {
    const metadata = get(this.metadataStore)

    const selectedIndex =
      selectedMsgId !== undefined ? metadata.findIndex(({ _id }) => _id === selectedMsgId) : undefined

    if (selectedIndex !== undefined && selectedIndex >= 0) {
      return selectedIndex
    }

    return firsNewMsgIndex
  }

  private async getFirstNewMsgIndex (): Promise<number | undefined> {
    const metadata = get(this.metadataStore)

    if (metadata.length === 0) {
      return undefined
    }

    if (this.context === undefined) {
      return -1
    }

    const lastViewedTimestamp = this.context.lastViewedTimestamp
    const client = getClient()
    const firstNotification = await client.findOne(
      notification.class.InboxNotification,
      {
        _class: {
          $in: [notification.class.MentionInboxNotification, notification.class.ActivityInboxNotification]
        },
        docNotifyContext: this.context._id,
        isViewed: false
      },
      { sort: { createdOn: SortingOrder.Ascending } }
    )

    if (lastViewedTimestamp === undefined && firstNotification === undefined) {
      return -1
    }

    const me = getCurrentAccount()._id

    let newTimestamp = 0

    if (lastViewedTimestamp !== undefined && firstNotification !== undefined) {
      newTimestamp = Math.min(lastViewedTimestamp ?? 0, firstNotification?.createdOn ?? 0)
    } else {
      newTimestamp = lastViewedTimestamp ?? firstNotification?.createdOn ?? 0
    }

    return metadata.findIndex((message) => {
      if (message.createdBy === me) {
        return false
      }

      const createdOn = message.createdOn ?? 0

      return newTimestamp < createdOn
    })
  }

  private updatesDates (metadata: MessageMetadata[]): void {
    const dates: Timestamp[] = []

    for (const [index, data] of metadata.entries()) {
      const date = data.createdOn

      if (date === undefined) {
        continue
      }

      if (index === 0) {
        dates.push(date)
      }

      const nextDate = metadata[index + 1]?.createdOn

      if (nextDate === undefined) {
        continue
      }

      if (isOtherDay(date, nextDate)) {
        dates.push(nextDate)
      }
    }

    this.datesStore.set(dates)
  }

  private clearMessages (): void {
    this.tailStore.set([])
    this.chunksStore.set([])
    this.isInitialLoadedStore.set(false)
    this.tailQuery.unsubscribe()
    this.tailStart = undefined
    this.isTailLoaded.set(false)
    this.backwardNextPromise = undefined
    this.forwardNextPromise = undefined
    this.forwardNextStore.set(undefined)
    this.backwardNextStore.set(undefined)
    this.isBackwardLoading.set(false)
    this.isForwardLoading.set(false)
  }

  public async jumpToDate (date: Timestamp): Promise<void> {
    const msg = get(this.metadataStore).find(({ createdOn }) => createdOn === date)

    if (msg === undefined) {
      return
    }

    this.clearMessages()
    await this.loadInitialMessages(msg._id)
  }

  public jumpToMessage (message: MessageMetadata): boolean {
    const metadata = get(this.metadataStore).find(({ _id }) => _id === message._id)

    if (metadata === undefined) {
      return false
    }

    const isAlreadyLoaded = get(this.messagesStore).some(({ _id }) => _id === message._id)

    if (isAlreadyLoaded) {
      return false
    }

    this.clearMessages()
    void this.loadInitialMessages(message._id)

    return true
  }

  public jumpToEnd (ignoreNew = false): boolean {
    const last = get(this.metadataStore)[get(this.metadataStore).length - 1]

    if (last === undefined) {
      return false
    }

    const isAlreadyLoaded = get(this.messagesStore).some(({ _id }) => _id === last._id)

    if (isAlreadyLoaded) {
      return false
    }

    this.selectedMsgId = undefined
    this.clearMessages()
    void this.loadInitialMessages(this.selectedMsgId, false, ignoreNew)

    return true
  }
}
