#pragma once

#include <memory>

#include "helper_automation.hpp"
#include "helper_types.hpp"

namespace opendelegate::windows_computer_use {

SecretKey read_bootstrap_secret(int descriptor);
bool run_protocol_crypto_self_test();
bool run_parent_process_auth_self_test();
int run_authenticated_named_pipe_server(const Configuration& configuration,
                                        SecretKey& secret,
                                        std::shared_ptr<WindowsAutomation> automation);

}  // namespace opendelegate::windows_computer_use
