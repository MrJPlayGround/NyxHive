'use client'

import { useEffect, useRef } from 'react'
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogRoot,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export const SESSION_DELETE_DEFAULT_ACTION = 'delete' as const

type SessionDeleteDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionTitle: string
  sessionCount?: number
  onConfirm: () => void
  onCancel: () => void
}

export function SessionDeleteDialog({
  open,
  onOpenChange,
  sessionTitle,
  sessionCount = 1,
  onConfirm,
  onCancel,
}: SessionDeleteDialogProps) {
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null)
  const isBulkDelete = sessionCount > 1

  useEffect(() => {
    if (!open || SESSION_DELETE_DEFAULT_ACTION !== 'delete') return
    const timer = window.setTimeout(() => {
      deleteButtonRef.current?.focus()
    }, 50)
    return () => window.clearTimeout(timer)
  }, [open])

  return (
    <AlertDialogRoot open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <div
          className="p-4"
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            onConfirm()
          }}
        >
          <AlertDialogTitle className="mb-1">
            {isBulkDelete ? `Delete ${sessionCount} Sessions` : 'Delete Session'}
          </AlertDialogTitle>
          <AlertDialogDescription className="mb-4">
            {isBulkDelete
              ? `Delete ${sessionCount} selected sessions? This action cannot be undone.`
              : `Are you sure you want to delete "${sessionTitle}"? This action cannot be undone.`}
          </AlertDialogDescription>
          <div className="flex justify-end gap-2">
            <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
            <AlertDialogAction ref={deleteButtonRef} onClick={onConfirm}>
              {isBulkDelete ? `Delete ${sessionCount}` : 'Delete'}
            </AlertDialogAction>
          </div>
          <p className="mt-2 text-right text-[11px] text-primary-500">
            Press Enter to delete, Esc to cancel.
          </p>
        </div>
      </AlertDialogContent>
    </AlertDialogRoot>
  )
}
