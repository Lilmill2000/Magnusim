//-----------------------------------------------------------------------------
// Created on: April 2012
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

#ifndef ActAPI_ILogger_HeaderFile
#define ActAPI_ILogger_HeaderFile

// Active Data (API) includes
#include <ActAPI_Variables.h>

// OCCT includes
#include <NCollection_DataMap.hxx>
#include <NCollection_Sequence.hxx>
#include <NCollection_Shared.hxx>
#include <NCollection_Vector.hxx>
#include <Standard_ProgramError.hxx>
#include <Standard_Type.hxx>
#include <TCollection_AsciiString.hxx>
#include <TColStd_MapIteratorOfPackedMapOfInteger.hxx>
#include <TColStd_PackedMapOfInteger.hxx>

#define LogInfo(PriorityShort) \
  ActAPI_LogStream(Severity_Information, Priority_##PriorityShort)
#define LogNotice(PriorityShort) \
  ActAPI_LogStream(Severity_Notice, Priority_##PriorityShort)
#define LogWarn(PriorityShort) \
  ActAPI_LogStream(Severity_Warning, Priority_##PriorityShort)
#define LogErr(PriorityShort) \
  ActAPI_LogStream(Severity_Error, Priority_##PriorityShort)

#if defined(ACT_DEBUG)
  #define LogInfo_Deb(PriorityShort) \
    ActAPI_LogStream(Severity_Information, Priority_##PriorityShort)
  #define LogNotice_Deb(PriorityShort) \
    ActAPI_LogStream(Severity_Notice, Priority_##PriorityShort)
  #define LogWarn_Deb(PriorityShort) \
    ActAPI_LogStream(Severity_Warning, Priority_##PriorityShort)
  #define LogErr_Deb(PriorityShort) \
    ActAPI_LogStream(Severity_Error, Priority_##PriorityShort)
#else
  #define LogInfo_Deb(PriorityShort) \
    ActAPI_LogStream()
  #define LogNotice_Deb(PriorityShort) \
    ActAPI_LogStream()
  #define LogWarn_Deb(PriorityShort) \
    ActAPI_LogStream()
  #define LogErr_Deb(PriorityShort) \
    ActAPI_LogStream()
#endif

#define ActAPI_LogStr_True TCollection_AsciiString("true")
#define ActAPI_LogStr_False TCollection_AsciiString("false")

//! \ingroup AD_DF
//!
//! Type definition for logging arguments of heterogeneous types.
typedef NCollection_Sequence<Handle(ActAPI_VariableBase)> ActAPI_LogArguments;

//! \ingroup AD_DF
//!
//! Priority of logged message.
enum ActAPI_LogMessagePriority
{
  Priority_Normal = 1, //!< Nothing special.
  Priority_High        //!< Important.
};

//! \ingroup AD_DF
//!
//! Severity of logged message.
enum ActAPI_LogMessageSeverity
{
  Severity_Information = 1, //!< Just information message.
  Severity_Notice,          //!< Notice message (can be important).
  Severity_Warning,         //!< Warning message.
  Severity_Error            //!< Error message.
};

//! \ingroup AD_DF
//!
//! Generic logging message.
struct ActAPI_LogMessage
{
  //! Priority tag.
  ActAPI_LogMessagePriority Priority;

  //! Severity tag.
  ActAPI_LogMessageSeverity Severity;

  //! Message text.
  std::string MsgKey;

  //! Arguments for logging message.
  ActAPI_LogArguments Arguments;

  //! Application-specific timestamp.
  Handle(Standard_Transient) TimeStamp;

  //! Default constructor.
  ActAPI_LogMessage()
  : Priority(Priority_Normal),
    Severity(Severity_Information)
  {}

  //! Complete constructor.
  //! \param priority  [in] message priority tag.
  //! \param severity  [in] message severity tag.
  //! \param msgKey    [in] message localization key.
  //! \param arguments [in] arguments for the logging message if any.
  //! \param timeStamp [in] application-specific timestamp.
  ActAPI_LogMessage(const ActAPI_LogMessagePriority   priority,
                    const ActAPI_LogMessageSeverity   severity,
                    const std::string&                msgKey,
                    const ActAPI_LogArguments&        arguments = ActAPI_LogArguments(),
                    const Handle(Standard_Transient)& timeStamp = nullptr)
  : Priority  (priority),
    Severity  (severity),
    MsgKey    (msgKey),
    Arguments (arguments),
    TimeStamp (timeStamp)
  {}

  virtual Standard_Boolean operator>(const ActAPI_LogMessage&) const
  {
    return Standard_False;
  }

  virtual Standard_Boolean operator==(const ActAPI_LogMessage&) const
  {
    return Standard_False;
  }
};

//! \ingroup AD_DF
//!
//! Short-cut for list of messages in OCCT thread-unsafe form.
typedef NCollection_Sequence<ActAPI_LogMessage> ActAPI_LogMessageList;

//! \ingroup AD_DF
//!
//! Logging tool.
class ActAPI_ILogger : public Standard_Transient
{
public:

  // OCCT RTTI
  DEFINE_STANDARD_RTTI_INLINE(ActAPI_ILogger, Standard_Transient)

public:

  ActData_EXPORT virtual
    ~ActAPI_ILogger();

// Logging abstract kernel:
public:

  virtual void
    Info(const std::string&                message,
         const ActAPI_LogMessagePriority   priority  = Priority_Normal,
         const ActAPI_LogArguments&        arguments = ActAPI_LogArguments(),
         const Handle(Standard_Transient)& timeStamp = nullptr) = 0;

  virtual void
    Notice(const std::string&                message,
           const ActAPI_LogMessagePriority   priority  = Priority_Normal,
           const ActAPI_LogArguments&        arguments = ActAPI_LogArguments(),
           const Handle(Standard_Transient)& timeStamp = nullptr) = 0;

  virtual void
    Warn(const std::string&                message,
         const ActAPI_LogMessagePriority   priority  = Priority_Normal,
         const ActAPI_LogArguments&        arguments = ActAPI_LogArguments(),
         const Handle(Standard_Transient)& timeStamp = nullptr) = 0;

  virtual void
    Error(const std::string&                message,
          const ActAPI_LogMessagePriority   priority  = Priority_Normal,
          const ActAPI_LogArguments&        arguments = ActAPI_LogArguments(),
          const Handle(Standard_Transient)& timeStamp = nullptr) = 0;

public:

  //! Appends output stream for replicating logging messages. This technique
  //! is useful if you want to accumulate logged messages in custom collections
  //! rather than only let the basic logging functionality do its job.
  //! \param[in] outStream output stream to append.
  virtual void AppendStream(Standard_OStream* outStream)
  {
    m_appenders.Append(outStream);
  }

  //! Removes all existing appender streams.
  virtual void ClearAppenders()
  {
    m_appenders.Clear();
  }

// Logging kernel:
public:

  ActData_EXPORT virtual void
    Dispatch(const ActAPI_LogMessageList& logList);

protected:

  //! Appender streams.
  NCollection_Vector<Standard_OStream*> m_appenders;

};

//! \ingroup AD_DF
//!
//! Convenience tool for message streaming.
class ActAPI_LogStream
{
public:

  //! Default constructor.
  ActAPI_LogStream()
  {
    m_bIsDummy          = Standard_True;
    m_bIsMsgInitialized = Standard_False;
  }

  //! Constructor.
  //! \param severity [in] severity of the Log Message.
  //! \param priority [in] priority of the Log Message.
  ActAPI_LogStream(const ActAPI_LogMessageSeverity& severity,
                   const ActAPI_LogMessagePriority& priority)
  {
    m_severity          = severity;
    m_priority          = priority;
    m_bIsDummy          = Standard_False;
    m_bIsMsgInitialized = Standard_False;
  }

  //! Converter to Log Message.
  //! \return Log Message.
  operator ActAPI_LogMessage()
  {
    return ActAPI_LogMessage(m_priority, m_severity, m_msg, m_args, NULL);
  }

  //! Pushes the passed value to the logging stream.
  //! \param theStr [in] value to stream.
  //! \return this instance for further streaming.
  ActAPI_LogStream& operator<<(Standard_CString str)
  {
    return this->operator<<( std::string(str) );
  }

  //! Pushes the passed value to the logging stream.
  //! \param str [in] value to stream.
  //! \return this instance for further streaming.
  ActAPI_LogStream& operator<<(const TCollection_AsciiString& str)
  {
    return this->operator<<( str.ToCString() );
  }

  //! Pushes the passed value to the logging stream.
  //! \param str [in] value to stream.
  //! \return this instance for further streaming.
  ActAPI_LogStream& operator<<(const std::string& str)
  {
    if ( m_bIsDummy )
      return *this;

    if ( !m_bIsMsgInitialized )
    {
      m_msg               = str;
      m_bIsMsgInitialized = Standard_True;
    }
    else
    {
      Handle(ActAPI_VariableString) aTStr = new ActAPI_VariableString(str);
      m_args.Append(aTStr);
    }

    return *this;
  }

  //! Pushes the passed value to the logging stream.
  //! \param val [in] value to stream.
  //! \return this instance for further streaming.
  ActAPI_LogStream& operator<<(const Standard_Integer val)
  {
    if ( m_bIsDummy )
      return *this;

    if ( !m_bIsMsgInitialized )
      Standard_ProgramError::Raise("Message must be initialized first");

    Handle(ActAPI_VariableInt) aTVal = new ActAPI_VariableInt(val);
    m_args.Append(aTVal);

    return *this;
  }

  //! Pushes the passed value to the logging stream.
  //! \param theVal [in] value to stream.
  //! \return this instance for further streaming.
  ActAPI_LogStream& operator<<(const Standard_Real val)
  {
    if ( m_bIsDummy )
      return *this;

    if ( !m_bIsMsgInitialized )
      Standard_ProgramError::Raise("Message must be initialized first");

    Handle(ActAPI_VariableReal) aTVal = new ActAPI_VariableReal(val);
    m_args.Append(aTVal);

    return *this;
  }

  //! Pushes the passed value to the logging stream.
  //! \param val [in] value to stream.
  //! \return this instance for further streaming.
  ActAPI_LogStream& operator<<(const Standard_Boolean val)
  {
    return this->operator<<(val ? ActAPI_LogStr_True : ActAPI_LogStr_False);
  }

  //! Pushes the passed shape to the logging stream.
  //! \param shape [in] shape to stream.
  //! \return this instance for further streaming.
  ActAPI_LogStream& operator<<(const TopoDS_Shape& shape)
  {
    if ( m_bIsDummy )
      return *this;

    if ( !m_bIsMsgInitialized )
      Standard_ProgramError::Raise("Message must be initialized first");

    Handle(ActAPI_VariableShape) aTVal = new ActAPI_VariableShape(shape);
    m_args.Append(aTVal);

    return *this;
  }

  //! Appends the passed integer mask to the logging stream.
  //! \param[in] mask integer mask to append.
  //! \return this for subsequent appends.
  ActAPI_LogStream&
    operator<<(const TColStd_PackedMapOfInteger& mask)
  {
    TCollection_AsciiString str;

    int iter = 0;
    for ( TColStd_MapIteratorOfPackedMapOfInteger mit(mask); mit.More(); mit.Next() )
    {
      if ( iter++ )
        str += " ";

      str += mit.Key();
    }

    return this->operator<<(str);
  }

  //! Pushes the streamed message to the passed Logger.
  //! \param logger [in] target Logger.
  void operator>>(const Handle(ActAPI_ILogger)& logger)
  {
    if ( m_bIsDummy )
      return;

    if ( logger.IsNull() )
      return;

    if ( m_severity == Severity_Information )
      logger->Info(m_msg, m_priority, m_args);
    if ( m_severity == Severity_Notice )
      logger->Notice(m_msg, m_priority, m_args);
    else if ( m_severity == Severity_Warning )
      logger->Warn(m_msg, m_priority, m_args);
    else if ( m_severity == Severity_Error )
      logger->Error(m_msg, m_priority, m_args);
  }

  //! Accessor for severity.
  //! \return message severity.
  ActAPI_LogMessageSeverity Severity() const
  {
    return m_severity;
  }

  //! Accessor for priority.
  //! \return message priority.
  ActAPI_LogMessagePriority Priority() const
  {
    return m_priority;
  }

  //! Accessor for text.
  //! \return message text.
  const std::string& Text() const
  {
    return m_msg;
  }

  //! Accessor for arguments.
  //! \return message arguments.
  const ActAPI_LogArguments& Args() const
  {
    return m_args;
  }

private:

  //! Message priority.
  ActAPI_LogMessagePriority m_priority;

  //! Message severity.
  ActAPI_LogMessageSeverity m_severity;

  //! Logging message.
  std::string m_msg;

  //! Logging arguments.
  ActAPI_LogArguments m_args;

  //! Internal status.
  Standard_Boolean m_bIsMsgInitialized;

  //! Indicates whether Logging Stream is dummy or not.
  Standard_Boolean m_bIsDummy;

};

#endif
