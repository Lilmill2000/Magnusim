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

// Own include
#include <asiAlgo_ProgressNotifier.h>

// asiALgo includes
#include <asiAlgo_Utils.h>

// OCCT includes
#include <Message_MsgFile.hxx>

// TBB includes
#ifdef USE_TBB
#include <spin_mutex.h>
#endif

//-----------------------------------------------------------------------------

asiAlgo_ProgressNotifier::asiAlgo_ProgressNotifier(Standard_OStream& os)
: ActAPI_IProgressNotifier (),
  m_out                    (os),
  m_bSendLogMessageCalled  (true),
  m_bProgressOn            (true)
{
  this->Reset();
}

/* =========================================================================
 *  Section: Methods to use in a single-threaded context
 *  Purpose: E.g. having a single GUI thread responsive to user events,
 *           you can call these methods in that thread, while it is
 *           prohibited to call them in the background working thread
 *           containing several tasks
 * ========================================================================= */

void asiAlgo_ProgressNotifier::Reset()
{
  m_status                = Progress_Undefined;
  m_iCapacity             = 0;
  m_msgKey                = TCollection_AsciiString();
  m_bSendLogMessageCalled = true;
  m_bProgressOn           = true;
  m_iProgress             = 0;
}

//-----------------------------------------------------------------------------

void asiAlgo_ProgressNotifier::Init(const int capacity)
{
  if ( !m_bProgressOn )
    return;

  m_status    = Progress_Running;
  m_iCapacity = capacity;
  m_iProgress = 0;
}

//-----------------------------------------------------------------------------

int asiAlgo_ProgressNotifier::Capacity() const
{
  return m_iCapacity;
}

//-----------------------------------------------------------------------------

bool asiAlgo_ProgressNotifier::IsInfinite() const
{
  return m_iCapacity == INT_MAX;
}

//-----------------------------------------------------------------------------

void asiAlgo_ProgressNotifier::SetMessageKey(const TCollection_AsciiString& msgKey)
{
  m_msgKey = msgKey;
}

//-----------------------------------------------------------------------------

TCollection_AsciiString asiAlgo_ProgressNotifier::MessageKey() const
{
  return m_msgKey;
}

//-----------------------------------------------------------------------------

void asiAlgo_ProgressNotifier::SetProgressStatus(const ActAPI_ProgressStatus status)
{
  if ( !m_bProgressOn )
    return;

  m_status = status;

  if ( m_status >= Progress_Succeeded )
  {
    TCollection_AsciiString prefix, verdict;
    //
    if ( m_status == Progress_Succeeded )
    {
      prefix = " + ";
      verdict = "succeeded";
    }
    else if ( m_status == Progress_Failed )
    {
      prefix = " - ";
      verdict = "failed";
    }
    else
    {
      prefix = " ? ";
      verdict = "done";
    }

    m_out << prefix << "   Operation " << verdict << ".\n";
  }
}

//-----------------------------------------------------------------------------

ActAPI_ProgressStatus asiAlgo_ProgressNotifier::ProgressStatus() const
{
  return m_status;
}

//-----------------------------------------------------------------------------

void asiAlgo_ProgressNotifier::Cancel()
{
  if ( !m_bProgressOn )
    return;

  m_status = Progress_Canceled;
}

//-----------------------------------------------------------------------------

bool asiAlgo_ProgressNotifier::IsCancelling()
{
  return m_status == Progress_Canceled;
}

//-----------------------------------------------------------------------------

bool asiAlgo_ProgressNotifier::IsRunning()
{
  return (m_status == Progress_Running);
}

//-----------------------------------------------------------------------------

bool asiAlgo_ProgressNotifier::IsFailed()
{
  return (m_status == Progress_Failed);
}

//-----------------------------------------------------------------------------

int asiAlgo_ProgressNotifier::CurrentProgress() const
{
  return m_iProgress;
}

//-----------------------------------------------------------------------------

void asiAlgo_ProgressNotifier::ProcessEvents() const
{
  // Do nothing.
}

//-----------------------------------------------------------------------------

void asiAlgo_ProgressNotifier::SetProgressOn()
{
  m_bProgressOn = true;
}

//-----------------------------------------------------------------------------

void asiAlgo_ProgressNotifier::SetProgressOff()
{
  m_bProgressOn = false;
}

//-----------------------------------------------------------------------------

void asiAlgo_ProgressNotifier::StepProgress(const int stepProgress)
{
  if ( !m_bProgressOn )
    return;

  m_iProgress += stepProgress;

#ifdef USE_TBB
  static tbb::spin_mutex MUTEX; // For console output only
  tbb::spin_mutex::scoped_lock lock(MUTEX); // Lock mutex and output some messages
#endif

  m_bSendLogMessageCalled = false;

  // Output current status (percentage or number of completed steps)
  int status;
  if ( this->IsInfinite() )
    status = this->CurrentProgress();
  else
    status = (int) ( (double) this->CurrentProgress() / this->Capacity() * 100);
  //
  m_out << "...\t progress"
        << (this->IsInfinite() ? " (infinite), current step is: " : ": ")
        << status
        << (this->IsInfinite() ? "" : "%")
        << "   "
        << "\r";
  //
  m_out.flush();
}

//-----------------------------------------------------------------------------

void asiAlgo_ProgressNotifier::SetProgress(const int progress)
{
  if ( !m_bProgressOn )
    return;

  m_iProgress = progress;
}

//-----------------------------------------------------------------------------

template<typename T>
std::string toString(const Handle(Standard_Transient)& theValue)
{
  Handle(T) aValue = Handle(T)::DownCast(theValue);
  if (aValue.IsNull())
    return "";

  std::string res = asiAlgo_Utils::Str::ToString(aValue->Value);
  return res;
}

//-----------------------------------------------------------------------------

std::string getString(const Handle(Standard_Transient)& theValue)
{
  std::string aStandInteger = toString<ActAPI_VariableInt>(theValue);
  if (!aStandInteger.empty())
    return aStandInteger;

  std::string aStandReal = toString<ActAPI_VariableReal>(theValue);
  if (!aStandReal.empty())
    return aStandReal;

  std::string aStandString = toString<ActAPI_VariableString>(theValue);
  if (!aStandString.empty())
    return aStandString;

  return "<empty arg>";
}

//-----------------------------------------------------------------------------

void asiAlgo_ProgressNotifier::SendLogMessage(const std::string&              message,
                                              const ActAPI_LogMessageSeverity severity,
                                              const ActAPI_LogMessagePriority /*priority*/,
                                              const ActAPI_LogArguments&      arguments)
{
#ifdef USE_TBB
  static tbb::spin_mutex MUTEX; // For console output only
  tbb::spin_mutex::scoped_lock lock(MUTEX); // Lock mutex and output some messages
#endif

  // Try to treat the passed message as a key
  std::string formatted;
  //
  if ( Message_MsgFile::HasMsg( message.c_str() ) )
    formatted = TCollection_AsciiString( Message_MsgFile::Msg(message.c_str() ) ).ToCString();
  else
    formatted = message;

  for ( int i = 1; i <= arguments.Length(); ++i )
  {
    std::string iarg = "%"; iarg += asiAlgo_Utils::Str::ToString<int>(i);
    size_t parg = formatted.find(iarg);
    std::string sarg = getString(arguments.Value(i));

    if ( parg != std::string::npos )
    {
      formatted.erase(parg, iarg.size());
      formatted.insert(parg, sarg);
    }
    else
    {
      formatted += " ";
      formatted += sarg;
    }
  }

  if ( !m_bSendLogMessageCalled )
  {
    m_bSendLogMessageCalled = true;
  }

  // Since carriage is returned in progress reporting by StepProgress() method,
  // we try to reserve enough characters to erase visually the line occupied
  // by the progress indication.
  if ( formatted.length() < 100 )
    for ( size_t k = formatted.length(); k < 100; ++k )
      formatted += " ";

  switch ( severity )
  {
    case Severity_Information:
      m_out << "...\t info: " << formatted << "\n";
      break;
    case Severity_Notice:
      m_out << "...\t notice: " << formatted << "\n";
      break;
    case Severity_Warning:
      m_out << "...\t warning: " << formatted << "\n";
      break;
    case Severity_Error:
      m_out << "...\t error: " << formatted << "\n";
      break;
    default:
      break;
  }

  m_out.flush();
}

//-----------------------------------------------------------------------------

void asiAlgo_ProgressNotifier::SendLogMessage(const ActAPI_LogStream& logStream)
{
  this->SendLogMessage( logStream.Text(),
                        logStream.Severity(),
                        logStream.Priority(),
                        logStream.Args() );
}
