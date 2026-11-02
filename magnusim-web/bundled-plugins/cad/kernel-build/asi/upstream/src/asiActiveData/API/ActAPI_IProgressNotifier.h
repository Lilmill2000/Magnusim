//-----------------------------------------------------------------------------
// Created on: July 2012
//-----------------------------------------------------------------------------
// Copyright (c) 2017, OPEN CASCADE SAS
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
//    * Neither the name of OPEN CASCADE SAS nor the
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
//
// Web: http://analysissitus.org
//-----------------------------------------------------------------------------

#ifndef ActAPI_IProgressNotifier_HeaderFile
#define ActAPI_IProgressNotifier_HeaderFile

// Active Data (API) includes
#include <ActAPI_ILogger.h>

// OCCT includes
#include <Standard_Type.hxx>

//! \ingroup AD_DF
//!
//! Progress status.
enum ActAPI_ProgressStatus
{
  Progress_Undefined = 0, //!< No status defined, no job has been ever started.
  Progress_Running,       //!< Job is currently running.
  Progress_Succeeded,     //!< Job has been performed successfully.
  Progress_Failed,        //!< Job has been failed.
  Progress_Canceled       //!< Job has been requested for cancellation.
};

//-----------------------------------------------------------------------------
// Progress Notifier
//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Interface for Progress Notifier concept. Progress Notifier provides
//! messaging mechanism for communications between algorithmic and GUI layers.
//! It is normally used in cases when GUI thread is running separately from
//! the working one, however, it is also suitable in a single-threaded
//! context (actually, it depends on the used implementation). Progress
//! Notifier provides the following services:
//!
//! - Accumulate PROGRESS as a single integer value less or equal to CAPACITY.
//!
//! - Set progress message describing the currently performed
//!   job. This is normally an ASCII string localization key.
//!
//! - Set completeness state for the entire process. The following states
//!   are supported: Not Defined, Running, Succeeded, Failed, Canceled.
class ActAPI_IProgressNotifier : public Standard_Transient
{
  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_IProgressNotifier, Standard_Transient)

public:

  ActData_EXPORT virtual
    ~ActAPI_IProgressNotifier();

// Thread-unsafe methods:
public:

  //! Cleans up the internal state of the Progress Notifier, so that it
  //! becomes ready to track another job.
  virtual void
    Reset() = 0;

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
  //! \param theCapacity [in] capacity to set (infinite by default).
  virtual void
    Init(const Standard_Integer theCapacity = INT_MAX) = 0;

  //! Returns the capacity value.
  //! \return requested capacity value.
  virtual Standard_Integer
    Capacity() const = 0;

  //! Returns true if the capacity value is infinite.
  //! \return true/false.
  virtual Standard_Boolean
    IsInfinite() const = 0;

  //! Sets message localization key.
  //! \param theMsgKey [in] localization key to set.
  virtual void
    SetMessageKey(const TCollection_AsciiString& theMsgKey) = 0;

  //! Returns message localization key.
  //! \return localization key.
  virtual TCollection_AsciiString
    MessageKey() const = 0;

  //! Sets the ultimate progress status for the job.
  //! \param theStatus [in] progress status to set.
  virtual void
    SetProgressStatus(const ActAPI_ProgressStatus theStatus) = 0;

  //! Returns current progress status.
  //! \return the ultimate progress status.
  virtual ActAPI_ProgressStatus
    ProgressStatus() const = 0;

  //! Requests job cancellation.
  virtual void
    Cancel() = 0;

  //! Checks whether the job is being canceled.
  //! \return true/false.
  virtual Standard_Boolean
    IsCancelling() = 0;

  //! Checks whether the job is in running state.
  //! \return true/false.
  virtual Standard_Boolean
    IsRunning() = 0;

  //! Checks whether the job is in failed state.
  //! \return true/false.
  virtual Standard_Boolean
    IsFailed() = 0;

  //! Returns the currently cumulated progress value.
  //! \return current cumulative progress.
  virtual Standard_Integer
    CurrentProgress() const = 0;

  //! Enables progress reporting.
  virtual void
    SetProgressOn() = 0;

  //! Disables progress reporting.
  virtual void
    SetProgressOff() = 0;

public:

  //! Callback to let the algorithmic thread pause so that
  //! UI events can be processed.
  virtual void
    ProcessEvents() const {}

// Tread-safe methods to be used by algorithms:
public:

  //! Thread-safe method used to increment the progress value by the passed step.
  //! \param theProgressStep [in] progress value to increment by.
  virtual void
    StepProgress(const Standard_Integer theProgressStep) = 0;

  //! Thread-safe method used to set the progress value.
  //! \param theProgress [in] progress value to set.
  virtual void
    SetProgress(const Standard_Integer theProgress) = 0;

  //! Thread-safe method used to send a logging message. Normally, this is
  //! not GUI directly as Progress Notifier is designed for usage in
  //! multi-threaded environment.
  //! \param theMessage [in] message string (normally it is i18n key).
  //! \param theSeverity [in] message severity (info, warning, error).
  //! \param thePriority [in] message priority (normal, high).
  //! \param theArguments [in] message arguments (if any).
  virtual void
    SendLogMessage(const std::string&              theMessage,
                   const ActAPI_LogMessageSeverity theSeverity,
                   const ActAPI_LogMessagePriority thePriority = Priority_Normal,
                   const ActAPI_LogArguments&      theArguments = ActAPI_LogArguments()) = 0;

  //! Thread-safe method used to send a logging message in a stream form.
  //! Normally, this is not GUI directly as Progress Notifier is designed for
  //! usage in multi-threaded environment.
  //! \param theLogStream [in] logging stream.
  virtual void
    SendLogMessage(const ActAPI_LogStream& theLogStream) = 0;

};

//-----------------------------------------------------------------------------
// Progress Entry
//-----------------------------------------------------------------------------

//! \ingroup AD_DF
//!
//! Convenient way to work with Progress Notifier. This class is mostly
//! useful due to its NULL-safe approach to working with the underlying
//! Progress Notifier.
class ActAPI_ProgressEntry
{
// Methods to use in single-threaded context:
public:

  //! Default constructor.
  ActAPI_ProgressEntry() {}

  //! Dummy conversion constructor.
  ActAPI_ProgressEntry(std::nullptr_t) {}

  //! Copy constructor.
  //! \param Entry [in] instance to copy.
  ActAPI_ProgressEntry(const ActAPI_ProgressEntry& Entry)
  {
    m_PNotifier = Entry.m_PNotifier;
  }

  //! Complete constructor.
  //! \param thePNotifier [in] Progress Notifier instance to set.
  ActAPI_ProgressEntry(const Handle(ActAPI_IProgressNotifier)& thePNotifier)
  {
    m_PNotifier = thePNotifier;
  }

// Thread-unsafe methods:
public:

  //! Null-safe Reset method for Progress Notifier.
  void Reset()
  {
    if ( !m_PNotifier.IsNull() )
      m_PNotifier->Reset();
  }

  //! Null-safe Init() method for Progress Notifier.
  //! \param theCapacity [in] capacity to set.
  void Init(const Standard_Integer theCapacity = INT_MAX)
  {
    if ( !m_PNotifier.IsNull() )
      m_PNotifier->Init(theCapacity);
  }

  //! Null-safe accessor for the capacity value.
  //! \return requested capacity value.
  Standard_Integer Capacity() const
  {
    if ( !m_PNotifier.IsNull() )
      return m_PNotifier->Capacity();

    return 0;
  }

  //! Null-safe checker for infinite capacity.
  //! \return true/false.
  Standard_Boolean IsInfinite() const
  {
    if ( !m_PNotifier.IsNull() )
      return m_PNotifier->IsInfinite();

    return Standard_False;
  }

  //! Null-safe SetMessageKey method for Progress Notifier.
  //! \param theMsgKey [in] localization key to set.
  void SetMessageKey(const TCollection_AsciiString& theMsgKey)
  {
    if ( !m_PNotifier.IsNull() )
      m_PNotifier->SetMessageKey(theMsgKey);
  }

  //! Null-safe accessor for the message localization key.
  //! \return localization key.
  TCollection_AsciiString MessageKey() const
  {
    if ( !m_PNotifier.IsNull() )
      return m_PNotifier->MessageKey();

    return TCollection_AsciiString();
  }

  //! Null-safe SetProgressStatus method for Progress Notifier.
  //! \param theStatus [in] progress status to set.
  void SetProgressStatus(const ActAPI_ProgressStatus theStatus)
  {
    if ( !m_PNotifier.IsNull() )
      m_PNotifier->SetProgressStatus(theStatus);
  }

  //! Null-safe accessor for the current progress status.
  //! \return the ultimately set progress status.
  ActAPI_ProgressStatus ProgressStatus() const
  {
    if ( !m_PNotifier.IsNull() )
      return m_PNotifier->ProgressStatus();

    return Progress_Undefined;
  }

  //! Null-safe Cancel method for Progress Notifier.
  void Cancel()
  {
    if ( !m_PNotifier.IsNull() )
      m_PNotifier->Cancel();
  }

  //! Null-safe IsCancelling checker.
  //! \return true/false.
  Standard_Boolean IsCancelling()
  {
    if ( !m_PNotifier.IsNull() )
      return m_PNotifier->IsCancelling();

    return Standard_False;
  }

  //! Null-safe IsRunning checker.
  //! \return true/false.
  Standard_Boolean IsRunning()
  {
    if ( !m_PNotifier.IsNull() )
      return m_PNotifier->IsRunning();

    return Standard_False;
  }

  //! Null-safe IsFailed checker.
  //! \return true/false.
  Standard_Boolean IsFailed()
  {
    if ( !m_PNotifier.IsNull() )
      return m_PNotifier->IsFailed();

    return Standard_False;
  }

  //! Null-safe accessor for the current progress.
  //! \return current progress.
  Standard_Integer CurrentProgress() const
  {
    if ( !m_PNotifier.IsNull() )
      return m_PNotifier->CurrentProgress();

    return 0;
  }

  //! Null-safe accessor for the `ProcessEvents()` method.
  void ProcessEvents() const
  {
    if ( !m_PNotifier.IsNull() )
      m_PNotifier->ProcessEvents();
  }

  //! Enables progress reporting.
  virtual void SetProgressOn()
  {
    if ( !m_PNotifier.IsNull() )
      m_PNotifier->SetProgressOn();
  }

  //! Disables progress reporting.
  virtual void SetProgressOff()
  {
    if ( !m_PNotifier.IsNull() )
      m_PNotifier->SetProgressOff();
  }

  //! Accessor for the underlying Progress Notifier.
  //! \return Progress Notifier instance.
  Handle(ActAPI_IProgressNotifier) Access() const
  {
    return m_PNotifier;
  }

// Thread-safe methods:
public:

  //! Null-safe StepProgress method for Progress Notifier.
  void StepProgress(const Standard_Integer theValue) const
  {
    if ( !m_PNotifier.IsNull() )
      m_PNotifier->StepProgress(theValue);
  }

  //! Null-safe SetProgress method for Progress Notifier.
  void SetProgress(const Standard_Integer theValue) const
  {
    if ( !m_PNotifier.IsNull() )
      m_PNotifier->SetProgress(theValue);
  }

  //! Null-safe SendLogMessage method for Progress Notifier.
  void SendLogMessage(const std::string&              theMessage,
                      const ActAPI_LogMessageSeverity theSeverity,
                      const ActAPI_LogMessagePriority thePriority = Priority_Normal,
                      const ActAPI_LogArguments&      theArguments = ActAPI_LogArguments()) const
  {
    if ( !m_PNotifier.IsNull() )
      m_PNotifier->SendLogMessage(theMessage, theSeverity, thePriority, theArguments);
  }

  //! Null-safe SendLogMessage method for Progress Notifier.
  //! \param theLogStream [in] logging stream.
  void SendLogMessage(const ActAPI_LogStream& theLogStream) const
  {
    if ( !m_PNotifier.IsNull() )
      m_PNotifier->SendLogMessage(theLogStream);
  }

private:

  //! Managed instance of Progress Notifier.
  Handle(ActAPI_IProgressNotifier) m_PNotifier;

};

#endif
