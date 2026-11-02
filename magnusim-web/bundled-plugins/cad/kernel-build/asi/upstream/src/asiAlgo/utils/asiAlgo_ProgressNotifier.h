//-----------------------------------------------------------------------------
// Created on: 22 June 2018
//-----------------------------------------------------------------------------
// Copyright (c) 2018, Sergey Slyadnev
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//    * Redistributions of source code must retain the above copyright
//      notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above copyright
//      notice, this list of conditions and the following disclaimer in the
//      documentation and/or other materials provided with the distribution.
//    * Neither the name of the copyright holder(s) nor the
//      names of all contributors may be used to endorse or promote products
//      derived from this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE AUTHORS OR CONTRIBUTORS BE LIABLE FOR ANY
// DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//-----------------------------------------------------------------------------

#ifndef asiAlgo_ProgressNotifier_h
#define asiAlgo_ProgressNotifier_h

// asiAlgo includes
#include <asiAlgo.h>

// Active Data includes
#include <ActAPI_IProgressNotifier.h>

#ifdef USE_TBB
  // TBB includes
  #include <atomic.h>
#endif

//! \ingroup ASI_CORE
//!
//! Notification tool to take care of algorithmic messages.
class asiAlgo_ProgressNotifier : public ActAPI_IProgressNotifier
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(asiAlgo_ProgressNotifier, ActAPI_IProgressNotifier)

public:

  //! Constructor.
  //! \param[in,out] os output stream.
  asiAlgo_EXPORT
    asiAlgo_ProgressNotifier(Standard_OStream& os);

// Thread-unsafe methods:
public:

  //! Cleans up the internal state of the Progress Notifier, so that it
  //! becomes ready to track another job.
  asiAlgo_EXPORT virtual void
    Reset();

  //! Initializes the Progress Notifier with the deterministic capacity
  //! value. Capacity represents the unitless overall progress value which
  //! can be ever collected by all running tasks.
  //!
  //! Please note, that by default the progress scale is declared with
  //! infinite capacity. Practically, it means that algorithm is not able
  //! to foresee the number of steps it will need to complete. Be sure that
  //! in such a case your interface reacts adequately (e.g. no percentage is
  //! shown to the user).
  //!
  //! \param[in] capacity capacity to set (infinite by default: INT_MAX).
  asiAlgo_EXPORT virtual void
    Init(const int capacity = INT_MAX);

  //! Returns the capacity value.
  //! \return requested capacity value.
  asiAlgo_EXPORT virtual int
    Capacity() const;

  //! Returns true if the capacity value is infinite.
  //! \return true/false.
  asiAlgo_EXPORT virtual bool
    IsInfinite() const;

  //! Sets message localization key.
  //! \param[in] msgKey localization key to set.
  asiAlgo_EXPORT virtual void
    SetMessageKey(const TCollection_AsciiString& msgKey);

  //! Returns message localization key.
  //! \return localization key.
  asiAlgo_EXPORT virtual TCollection_AsciiString
    MessageKey() const;

  //! Sets the ultimate progress status for the job.
  //! \param[in] status progress status to set.
  asiAlgo_EXPORT virtual void
    SetProgressStatus(const ActAPI_ProgressStatus status);

  //! Returns current progress status.
  //! \return ultimate progress status.
  asiAlgo_EXPORT virtual ActAPI_ProgressStatus
    ProgressStatus() const;

  //! Requests job cancellation.
  asiAlgo_EXPORT virtual void
    Cancel();

  //! Checks whether the job is being cancelled.
  //! \return true/false.
  asiAlgo_EXPORT virtual bool
    IsCancelling();

  //! Checks whether the job is in running state.
  //! \return true/false.
  asiAlgo_EXPORT virtual bool
    IsRunning();

  //! Checks whether the job is in failed state.
  //! \return true/false.
  asiAlgo_EXPORT virtual bool
    IsFailed();

  //! Returns the currently cumulated progress value.
  //! \return current cumulative progress.
  asiAlgo_EXPORT virtual int
    CurrentProgress() const;

  //! Callback to let the algorithmic thread pause so that
  //! UI events can be processed.
  asiAlgo_EXPORT virtual void
    ProcessEvents() const;

  //! Enables progress reporting.
  asiAlgo_EXPORT virtual void
    SetProgressOn();

  //! Disables progress reporting.
  asiAlgo_EXPORT virtual void
    SetProgressOff();

// Methods to be used by parallel algorithms (should be thread-safe):
public:

  //! Thread-safe method used to increment the progress value by the passed step.
  //! \param[in] progressStep progress value to increment by.
  asiAlgo_EXPORT virtual void
    StepProgress(const int progressStep);

  //! Thread-safe method used to set the progress value.
  //! \param[in] progress progress value to set.
  asiAlgo_EXPORT virtual void
    SetProgress(const int progress);

  //! Thread-safe method used to send a logging message. Normally, this is
  //! not GUI directly as Progress Notifier is designed for usage in
  //! multi-threaded environment.
  //! \param[in] message   message string (normally it is i18n key).
  //! \param[in] severity  message severity (info, warning, error).
  //! \param[in] priority  message priority (normal, high).
  //! \param[in] arguments message arguments (if any).
  asiAlgo_EXPORT virtual void
    SendLogMessage(const std::string&              message,
                   const ActAPI_LogMessageSeverity severity,
                   const ActAPI_LogMessagePriority priority  = Priority_Normal,
                   const ActAPI_LogArguments&      arguments = ActAPI_LogArguments());

  //! Thread-safe method used to send a logging message in a stream form.
  //! Normally, this is not GUI directly as Progress Notifier is designed for
  //! usage in multi-threaded environment.
  //! \param[in] logStream logging stream.
  asiAlgo_EXPORT virtual void
    SendLogMessage(const ActAPI_LogStream& logStream);

// Concurrent collections:
private:

  //! Output stream.
  Standard_OStream& m_out;

  //! Current progress.
#ifdef USE_TBB
  tbb::atomic<int> m_iProgress;
#else
  int m_iProgress;
#endif

// Single-threaded members:
private:

  //! Maximum allowed capacity.
  int m_iCapacity;

  //! Message key for short-description the working algorithm might want
  //! to associate with the Progress Collector.
  TCollection_AsciiString m_msgKey;

  //! Progress status.
  ActAPI_ProgressStatus m_status;

  //! Indicates whether a message is logged.
  bool m_bSendLogMessageCalled;

  //! Indicates whether progress reporting is on.
  bool m_bProgressOn;

private:

  void operator=(const asiAlgo_ProgressNotifier&) = delete;
  asiAlgo_ProgressNotifier(const asiAlgo_ProgressNotifier& pn) = delete;

};

#endif
